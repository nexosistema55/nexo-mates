// HEIC_FIXTURE: public libheif example.heic, not a personal photograph.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root,'app.js'),'utf8');
const functions = app.slice(app.indexOf('function readFileAsDataUrl('),app.indexOf('function slugifyCatalogValue('));
const sample = fs.readFileSync(process.env.HEIC_FIXTURE);
async function main() {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    for (const viewport of [{width:1280,height:900},{width:390,height:844}]) {
      const context = await browser.newContext({viewport});
      const page = await context.newPage();
      const requests=[];
      const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        requests.push(url.href);
        assert.equal(url.origin,'https://heic.test','No conversion services or database');
        if (url.pathname==='/') return route.fulfill({contentType:'text/html',body:`
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>*{box-sizing:border-box}body{margin:16px;font-family:Arial}main{max-width:700px}input{max-width:100%}#productImagePreview{display:flex;flex-wrap:wrap;gap:8px}.product-image-tile{width:120px}.product-image-tile img{width:120px;height:120px;object-fit:contain}button{min-height:40px}</style>
          <main><input id="productImageFiles" type="file" accept=".heic,.heif,image/*" multiple>
          <input id="productImageUrls" type="hidden"><div id="productImagePreview"></div>
          <button id="saveProductButton">Guardar Producto</button><p id="status" role="status"></p></main>
          <script src="/product-heic.js"></script>`});
        const file=path.join(root,decodeURIComponent(url.pathname));
        if (!file.startsWith(root+path.sep)) return route.abort();
        return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(file)});
      });
      await page.goto('https://heic.test/');
      await page.addScriptTag({content:`
        let productImageDraft=[];
        const normalizeProductImageUrls=values=>[...new Set(values)];
        const htmlAttr=value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const showActionToast=text=>document.getElementById('status').textContent=text;
        ${functions}
        document.getElementById('productImageFiles').addEventListener('change',async e=>{await addProductImageFiles(e.target.files);e.target.value='';});
        window.inspectImages=()=>productImageDraft;
      `});
      assert.equal(requests.some(u=>u.includes('heic-to-1.6.6.js')),false,'Lazy decoder');
      await page.evaluate(async()=>{
        assert = (value)=>{if(!value)throw Error('Detection failed');};
        assert(NexoHeic.isImage(new File(['x'],'IPHONE.HEIC',{type:''})));
        assert(NexoHeic.isImage(new File(['x'],'photo.heif',{type:'application/octet-stream'})));
        assert(!NexoHeic.isImage(new File(['x'],'document.pdf',{type:'application/pdf'})));
        const canvas=document.createElement('canvas');canvas.width=20;canvas.height=30;
        canvas.getContext('2d').fillRect(0,0,20,30);
        const png=await new Promise(r=>canvas.toBlob(r,'image/png'));
        await addProductImageFiles([new File([png],'photo.png',{type:'image/png'})]);
      });
      assert.equal(requests.some(u=>u.includes('heic-to-1.6.6.js')),false,'PNG needs no decoder');
      await page.locator('#productImageFiles').setInputFiles({name:'IPHONE.HEIC',mimeType:'',buffer:sample});
      await page.waitForFunction(()=>document.getElementById('status').textContent.includes('foto cargada.'),{},{timeout:60000});
      await page.waitForFunction(()=>window.inspectImages().length===2,{},{timeout:60000});
      const info=await page.evaluate(async()=>{
        const urls=inspectImages();const image=new Image();image.src=urls[1];await image.decode();
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
        const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
        return {webp:urls[1].startsWith('data:image/webp;'),width:image.width,height:image.height,
          visible:pixels.some((v,i)=>i%4!==3&&v>30),overflow:document.documentElement.scrollWidth>innerWidth,
          disabled:document.getElementById('saveProductButton').disabled};
      });
      assert.equal(info.webp,true);assert.ok(info.width<=1600&&info.height<=1600);
      assert.ok(info.visible);assert.equal(info.overflow,false);assert.equal(info.disabled,false);
      await page.locator('#productImageFiles').setInputFiles({name:'broken.heic',mimeType:'application/octet-stream',buffer:Buffer.from('not a HEIC')});
      await page.waitForFunction(()=>document.getElementById('status').textContent.includes('sin cargar'),{},{timeout:30000});
      assert.equal(await page.evaluate(()=>inspectImages().length),2,'Corrupt HEIC is not saved');
      assert.equal(await page.locator('#saveProductButton').isEnabled(),true);
      // Missing MIME HEIF, repeated selection and shared lazy module.
      await page.locator('#productImageFiles').setInputFiles({name:'second.HEIF',mimeType:'application/octet-stream',buffer:sample});
      await page.waitForFunction(()=>!document.getElementById('productImageFiles').disabled,{},{timeout:60000});
      assert.equal(requests.filter(u=>u.includes('heic-to-1.6.6.js')).length,1);
      assert.deepEqual(errors,[]);
      if(process.env.HEIC_SCREENSHOTS) await page.screenshot({path:path.join(process.env.HEIC_SCREENSHOTS,`heic-${viewport.width}.png`),fullPage:true});
      console.log(`PASS ${viewport.width}px: real HEIC/HEIF -> nonblank WebP; lazy/local decoder; corrupt files; controls; no overflow.`);
      await context.close();
    }
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
