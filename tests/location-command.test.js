import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isLocationCommand,currentLocationMessage,locationLinks,runLocationCommand} from '../location-command.js';
const escape = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
test('only standalone location command triggers permission',()=>{assert.ok(isLocationCommand(' /LOCATION '));assert.ok(!isLocationCommand('please /location'));assert.ok(!isLocationCommand('/location later'));});
test('fresh coordinates become a valid Maps search link',async()=>{
 const text=await currentLocationMessage({getCurrentPosition(ok,fail,options){assert.equal(options.maximumAge,0);assert.equal(options.enableHighAccuracy,true);assert.equal(options.timeout,20000);ok({coords:{latitude:40.1234567,longitude:-75.5,accuracy:12.3}});}});
 const url=new URL(text.slice(text.indexOf('https:')));assert.equal(url.searchParams.get('query'),'40.123457,-75.500000');assert.match(text,/13 m/);
 assert.match(locationLinks(text,escape),/target="_blank" rel="noopener noreferrer"/);
});
for(const code of [1,2,3])test(`geolocation error ${code} sends nothing`,async()=>{
 let sends=0,status='';const result=await runLocationCommand({active:()=>true,locate:()=>currentLocationMessage({getCurrentPosition(ok,fail){fail({code});}}),send:()=>sends++,status:s=>status=s});assert.equal(result,false);assert.equal(sends,0);assert.ok(status.length>20);
});
test('leaving chat while locating cancels the send',async()=>{let sends=0;assert.equal(await runLocationCommand({active:()=>false,locate:async()=> 'url',send:()=>sends++,status:()=>{}}),false);assert.equal(sends,0);});
test('failed delivery is reported without success',async()=>{let status;assert.equal(await runLocationCommand({active:()=>true,locate:async()=> 'url',send:async()=>false,status:s=>status=s}),false);assert.match(status,/not sent/);});
test('successful delivery reports success',async()=>{let sent,status;assert.equal(await runLocationCommand({active:()=>true,locate:async()=> 'map link',send:async text=>{sent=text;return true;},status:s=>status=s}),true);assert.equal(sent,'map link');assert.equal(status,'Location sent.');});
test('untrusted text cannot inject markup or javascript links',()=>{const rendered=locationLinks('<img src=x onerror="alert(1)"> javascript:alert(1)',escape);assert.ok(!rendered.includes('<img'));assert.ok(!rendered.includes('<a'));});
test('missing location API and invalid coordinates fail',async()=>{await assert.rejects(currentLocationMessage(null),/unavailable/);await assert.rejects(currentLocationMessage({getCurrentPosition(ok){ok({coords:{latitude:NaN,longitude:0}});}}),/determine/);});
