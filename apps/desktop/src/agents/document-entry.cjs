// Dedicated helper entry, compatible with packaged Electron and system Node.
let app;
if (process.versions.electron) {
  ({app}=require('electron'));
  app.commandLine.appendSwitch('ozone-platform','headless');
  app.disableHardwareAcceleration();
}
import('./document-cli.mjs').then(({run})=>run()).then(
  ()=>app?app.exit(0):undefined,
  error=>{console.error(error.message);if(app)app.exit(1);else process.exitCode=1;},
);
