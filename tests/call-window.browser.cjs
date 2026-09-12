// Run from the repository root with Playwright installed: node tests/call-window.browser.cjs
const fs=require('fs');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 for(const size of [{width:390,height:844},{width:1366,height:768}]){
 const page=await browser.newPage({viewport:size});
 await page.route('https://mayfly.test/**',route=>{const path=new URL(route.request().url()).pathname.slice(1)||'index.html';let body=fs.readFileSync(path,'utf8');if(path==='index.html')body=body.replace('<script type="module" src="app.js"></script>',`<script type="module">import {initCallWindow} from './call-window.js';window.cw=initCallWindow({toast:console.log});document.querySelector('#callo').classList.add('on');document.querySelector('#app').innerHTML='<button id="chat-test">Send message</button>';document.querySelector('#chat-test').onclick=()=>window.clicked=true;</script>`);route.fulfill({body,contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});});
 await page.goto('https://mayfly.test/');await page.locator('#cmin').click();
 await page.locator('#chat-test').click();
 await page.evaluate(()=>{
  document.querySelector('#cstat').textContent='Test call';
  for(const [id,label] of [['cmute','Mic'],['ccam','Cam'],['cflip','Flip'],['chang','End']])document.getElementById(id).textContent=label;
 });

 if(!await page.evaluate(()=>window.clicked))throw Error('Chat inaccessible');
 let r=await page.locator('#callo').boundingBox();if(r.width>240||r.x<0||r.y<0||r.x+r.width>size.width)throw Error('Mini bounds');
 await page.locator('#cdrag').hover();await page.mouse.down();await page.mouse.move(40,180);await page.mouse.up();
 r=await page.locator('#callo').boundingBox();if(r.x<0||r.y<0)throw Error('Drag bounds');
 await page.locator('#cmin').click();r=await page.locator('#callo').boundingBox();if(r.width!==size.width)throw Error('Restore bounds');
 await page.evaluate(()=>cw.reset());
 await page.evaluate(()=>{
  const v=document.querySelector('#rv');
  Object.defineProperty(v,'srcObject',{configurable:true,value:{getVideoTracks:()=>[{readyState:'live'}]}});
  Object.defineProperty(document,'pictureInPictureEnabled',{configurable:true,value:true});
  v.requestPictureInPicture=async()=>{window.pipRequested=true;Object.defineProperty(document,'pictureInPictureElement',{configurable:true,value:v});};
  document.exitPictureInPicture=async()=>{window.pipExited=true;Object.defineProperty(document,'pictureInPictureElement',{configurable:true,value:null});};
  window.dispatchEvent(new Event('call-media-changed'));
 });
 await page.locator('#cpip').click();
 if(!await page.evaluate(()=>window.pipRequested&&document.querySelector('#callo').classList.contains('mini')))throw Error('PiP request');
 await page.locator('#cmin').click();
 if(!await page.evaluate(()=>window.pipExited))throw Error('PiP cleanup');
 await page.evaluate(()=>{document.querySelector('#rv').requestPictureInPicture=async()=>{throw Error('unsupported')};});
 await page.locator('#cpip').click();
 if(await page.locator('#callo').evaluate(e=>e.classList.contains('mini')))throw Error('PiP failure state');
 await page.locator('#cmin').click();
 await page.setViewportSize({width:size.width,height:360});
 r=await page.locator('#callo').boundingBox();if(r.y+r.height>360)throw Error('Keyboard viewport bounds');
 await page.evaluate(()=>cw.reset());
 console.log('Call window passed',size.width);await page.close();
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
