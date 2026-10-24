'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('drawingCapture',{invoke:(op,payload)=>{if(!['read','save','commit','cancel','recover','discard'].includes(op))return Promise.reject(Error('Unknown drawing operation'));return ipcRenderer.invoke('nozeli:capture',op,payload);}});
