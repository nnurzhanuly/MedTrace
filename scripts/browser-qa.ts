import {chromium} from 'playwright-core';
import {mkdir} from 'node:fs/promises';
async function main(){
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
await mkdir('qa',{recursive:true});
for(const [name,width,height] of [['desktop',1440,900],['mobile',390,844]] as const){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:3000',{waitUntil:'networkidle'});
 await page.getByLabel('Почта').fill('admin@medtrace.demo');
 await page.getByLabel('Пароль').fill('MedTrace2026!');
 await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('heading',{name:'Операционный журнал'}).waitFor();
 await page.screenshot({path:`qa/${name}-home.png`,fullPage:true});
 if(name==='mobile')await page.getByRole('button',{name:'Открыть меню'}).click();
 await page.getByRole('button',{name:'Прослеживаемость'}).click();
 if(name==='mobile')await page.waitForTimeout(250);
 await page.getByPlaceholder('RM-2026-000001 / FG-2026-000001').fill('RM-2026-000001');
 await page.getByRole('button',{name:'Найти связи'}).click();
 await page.getByText('Карта происхождения и получателей').waitFor();
 await page.screenshot({path:`qa/${name}-trace.png`,fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
 console.log(name,{overflow,pageErrors:errors,traceNodes:await page.locator('.graph-node').count()});
 await page.close();
}
await browser.close();

}
main().catch(e=>{console.error(e);process.exit(1)});
