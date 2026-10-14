import {createApp,configFromEnv} from './index.mjs';
const config=configFromEnv({...process.env,NODE_ENV:'development',ALLOW_DEV_LOGIN:'1',APP_ORIGIN:'http://127.0.0.1:3000',HOST:'127.0.0.1',PORT:'3000'});
const app=createApp(config);
app.server.listen(config.port,config.host,()=>console.log('游戏 http://127.0.0.1:3000 · 后台 http://127.0.0.1:3000/admin · 仅本机开发登录'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{app.close().then(()=>process.exit(0));});
