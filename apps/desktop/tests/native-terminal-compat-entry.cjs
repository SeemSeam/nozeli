const {app}=require('electron');app.disableHardwareAcceleration();
import('./native-terminal-compat-live.mjs').then(({run})=>run()).then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
