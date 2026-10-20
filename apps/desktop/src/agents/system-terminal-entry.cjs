let app;
if(process.versions.electron){({app}=require('electron'));app.commandLine.appendSwitch('ozone-platform','headless');app.disableHardwareAcceleration();}
import('./system-terminal-client.mjs').then(({run})=>run()).then(()=>app?app.exit(0):undefined,error=>{console.error(error.message);if(app)app.exit(1);else process.exitCode=1;});
