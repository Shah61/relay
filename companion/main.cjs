const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, utilityProcess, Menu, Tray, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
app.setName('Prompt Manager Companion');
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let window, worker, tray, quitting = false, pending = null, enrolled = null, bridgeState = 'starting', lastError = '', restartTimer, pollingTimer;
  const product = JSON.parse(fs.readFileSync(path.join(__dirname, 'product.json'), 'utf8'));
  const configured = product.configured === true;
  if (configured) for (const [name, protocol] of [['dashboardOrigin','https:'],['relayOrigin','https:']]) { const u = new URL(product[name]); if (u.protocol !== protocol || u.origin !== product[name] || u.username || u.password) throw Error('Invalid product release configuration'); }
  const data = app.getPath('userData'), state = path.join(data, '.bridge'), credentialFile = path.join(data, 'computer-credential.enc');
  fs.mkdirSync(state,{recursive:true,mode:0o700});
  const configFile = path.join(data,'config.local.json');
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile,JSON.stringify({projects:{},browser:{port:47842}}),{mode:0o600});
  const config = () => JSON.parse(fs.readFileSync(configFile,'utf8'));
  function protect(value) {
    if (!['darwin','win32'].includes(process.platform) || !safeStorage.isEncryptionAvailable()) throw Error('Secure operating-system storage is unavailable. The computer has not been enrolled.');
    const encrypted = safeStorage.encryptString(JSON.stringify(value));
    fs.writeFileSync(credentialFile+'.tmp',encrypted,{mode:0o600}); fs.renameSync(credentialFile+'.tmp',credentialFile);
  }
  async function relay(pathname, body) {
    if (!configured) throw Error('Service not configured in this development build');
    const response = await fetch(product.relayOrigin+pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});
    const result = await response.json(); if (!response.ok) throw Error(result.error || 'Connection failed'); return result;
  }
  async function local(pathname, body) {
    const connection = JSON.parse(fs.readFileSync(path.join(state,'connection.json'),'utf8'));
    const url = new URL(connection.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/') throw Error('Invalid local bridge address');
    const response = await fetch(url.origin+pathname,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+fs.readFileSync(path.join(state,'token'),'utf8').trim(),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});
    if (!response.ok) throw Error('Local companion is not ready'); return response.json();
  }
  function bootBridge() {
    if (quitting || worker) return;
    worker = utilityProcess.fork(path.join(__dirname,'../runtime/src/bridge/server.js'),[],{env:{...process.env,PROMPT_MANAGER_DATA_DIR:data,PROMPT_MANAGER_MANAGED:'1'},stdio:'pipe',serviceName:'Prompt Manager local agents'});
    worker.on('exit',()=>{worker=null;bridgeState='offline'; if (!quitting) restartTimer=setTimeout(bootBridge,5000);});
    worker.stdout?.on('data',()=>{}); worker.stderr?.on('data',()=>{});
    let wired = false;
    clearInterval(pollingTimer);
    pollingTimer=setInterval(async()=>{
      try {
        const status=await local('/admin/companion/status'); bridgeState=status.state;
        if (enrolled && !wired && status.state !== 'starting') {
          await local('/admin/companion/connect',{hostId:enrolled.hostId,hostName:enrolled.hostName,hostToken:enrolled.credential,account:enrolled.account,relayUrl:product.relayOrigin.replace(/^https:/,'wss:'),frontendUrl:product.dashboardOrigin}); wired=true;
        }
      }catch{bridgeState='starting';}
    },3000);
  }
  function show() {
    if (window) { window.show(); window.focus(); return; }
    window=new BrowserWindow({width:540,height:780,minWidth:430,title:'Prompt Manager Companion',backgroundColor:'#f8f5fc',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    window.loadFile(path.join(__dirname,'index.html'));
    window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
  }
  const trusted = event => { if(event.senderFrame?.url !== pathToFileURL(path.join(__dirname,'index.html')).href) throw Error('Untrusted companion window'); };
  function handle(name, fn) { ipcMain.handle(name, async (event,...args)=>{trusted(event);return fn(...args);}); }
  app.whenReady().then(async()=>{
    if(fs.existsSync(credentialFile)) {
      try { if(!safeStorage.isEncryptionAvailable()) throw Error(); enrolled=JSON.parse(safeStorage.decryptString(fs.readFileSync(credentialFile))); }
      catch {lastError='Unable to unlock this computer credential. Unlock your operating-system secure storage and reopen the companion.';}
    }
    handle('pm:status',()=>({configured,name:os.hostname(),enrolled:!!enrolled,pending:!!pending,connected:bridgeState==='connected',projects:Object.keys(config().projects),autoStart:app.getLoginItemSettings().openAtLogin,packaged:app.isPackaged,error:lastError}));
    handle('pm:connect',async()=>{
      if(pending || enrolled) return;
      if(!safeStorage.isEncryptionAvailable()) throw Error('Secure operating-system storage is unavailable');
      pending=await relay('/account-api/enrollment/start',{name:os.hostname(),platform:process.platform}); lastError='';
      const verification=new URL(pending.verificationUrl); if(verification.origin!==product.dashboardOrigin) {pending=null;throw Error('Unexpected authorization destination');}
      await shell.openExternal(verification.href);
      void (async()=>{
        try {
          while(pending && Date.now()<pending.expires && !quitting) {
            await new Promise(r=>setTimeout(r,3000));
            const result=await relay('/account-api/enrollment/poll',{id:pending.id,pollSecret:pending.pollSecret});
            if(result.state==='authorized') {
              protect(result); enrolled=result;
              await relay('/account-api/enrollment/ack',{id:pending.id,pollSecret:pending.pollSecret}).catch(()=>{});
              if(app.isPackaged) app.setLoginItemSettings({openAtLogin:true,args:['--background']});
              // The managed bridge receives the credential over authenticated loopback only, never in a file or process arguments.
              await local('/admin/companion/connect',{hostId:result.hostId,hostName:result.hostName,hostToken:result.credential,account:result.account,relayUrl:product.relayOrigin.replace(/^https:/,'wss:'),frontendUrl:product.dashboardOrigin});
              pending=null; return;
            }
          }
          lastError='Connection request expired. Choose Connect this computer to try again.';
        }catch(error){lastError=error.message;} finally{pending=null;}
      })();
    });
    handle('pm:dashboard',()=>{if(!configured)throw Error('Service not configured');return shell.openExternal(product.dashboardOrigin);});
    handle('pm:project',async()=>{
      const selected=await dialog.showOpenDialog(window,{title:'Choose a local project',properties:['openDirectory']}); if(selected.canceled)return;
      const folder=fs.realpathSync(selected.filePaths[0]),current=config();
      if(Object.values(current.projects).includes(folder))return;
      const id=path.basename(folder).replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,45)+'-'+randomUUID().slice(0,8);
      await local('/admin/companion/project',{id,path:folder}); current.projects[id]=folder;
      fs.writeFileSync(configFile+'.tmp',JSON.stringify(current),{mode:0o600});fs.renameSync(configFile+'.tmp',configFile);
    });
    handle('pm:pair',()=>local('/admin/companion/pair',{}));
    handle('pm:autostart',enabled=>{if(!app.isPackaged)throw Error('Automatic startup is available after installation');app.setLoginItemSettings({openAtLogin:enabled===true,args:['--background']});});
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect x="2" y="2" width="20" height="20" rx="6" fill="#7044c6"/><path d="M8 17V7h6a3 3 0 0 1 0 6H8m4 0 5 4" fill="none" stroke="white" stroke-width="2"/></svg>';
    tray=new Tray(nativeImage.createFromDataURL('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')));
    tray.setToolTip('Prompt Manager Companion');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Prompt Manager',click:show},{label:'Quit',click:()=>app.quit()}]));tray.on('click',show);
    bootBridge(); if(!process.argv.includes('--background'))show();
  });
  app.on('second-instance',show);app.on('activate',show);app.on('window-all-closed',()=>{});
  app.on('before-quit',()=>{quitting=true;clearInterval(pollingTimer);clearTimeout(restartTimer);worker?.kill();});
}
