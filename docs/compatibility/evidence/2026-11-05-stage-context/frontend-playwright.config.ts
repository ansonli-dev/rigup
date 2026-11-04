import upstream from './frontend/apps/react-vite/playwright.config';

const app='/private/tmp/rigup-context-e2e-z2Q0V6/frontend/apps/react-vite';
const evidence='/private/tmp/rigup-context-e2e-z2Q0V6';
export default {
 ...upstream,
 testDir: app+'/e2e',
 workers: 1,
 retries: 0,
 reporter: [['json',{outputFile:evidence+'/frontend-browser-e2e.json'}],['list']],
 outputDir: evidence+'/frontend-browser-artifacts',
 use: {...upstream.use,baseURL:'http://127.0.0.1:41751'},
 projects: upstream.projects?.map(project=>({...project,use:{...project.use,...(project.name==='chromium'?{storageState:app+'/e2e/.auth/user.json'}:{})}})),
 webServer: {
  ...upstream.webServer,
  command: "/private/tmp/rigup-github-e2e-Ob73Xm"+'/tooling/node_modules/.bin/yarn dev --host 127.0.0.1 --port 41751 --strictPort',
  cwd: app,
  timeout: 30000,
  port: 41751,
  reuseExistingServer: false,
 },
};
