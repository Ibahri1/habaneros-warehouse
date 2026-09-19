import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfText } from "../_shared/pdf-text.mjs";

type ReportItem={product_id:string;name:string;category:string;available:number};
type ReportRun={claimed?:boolean;id:string;generated_at:string;item_count:number;recipients:string[];snapshot:ReportItem[];status:string};
// Keep this list aligned with the headers sent by supabase-js. The scheduler
// secret is additional and remains backend-only. `*` permits localhost and
// the deployed static warehouse site; authorization is still enforced below.
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage, x-reorder-scheduler-secret","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Max-Age":"86400"};
const LOGO_BASE64="iVBORw0KGgoAAAANSUhEUgAAADwAAAAtCAYAAADydghMAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAAEnQAABJ0Ad5mH3gAAAxVSURBVGhD7Zh5cJTnfcc/z/PuqV2J1Q2SQAghzBUBxlwOGAw+WsetB5vYmbROaBu3k056pM3hND0m0xxtEwJ2nMSTdDyuW+MG23V8As7UjsEcsTuAFXB0mUuwkhBC0mq1x7vv+/z6x+5Ki6K0tuQyU+LvzM777vtcv+/zO59HiYjwawQ9/sPVjg8IX+34gPDVjg8IX+1Q/1d5eKJplVKICEqp8U1XDJMiXDhERBAErRQwRiRPLv+e7zvR9yuJSZm0UmpUWK01lrZQKjuViIAaI6eUIh2NIsb8/9ewUopz3ac5c66T2TObqJ1en+sALgYZjDGw92Uyvb1YkQjlm+/ACoezY/Wk9nrKmBRhk9PWmeg7HD76GoualtJ28jjHO45y27rNLF28Gh9eeh9/nMimG/HPrCPddY7YwcNU3H0XiEBOy1da25MmrLXmbPQURYEiKsqqAdj57A+oiFQQc1LUDUPz4lUUzW3E2Dba52No/+t4q6oIzmtCjEFb1hU38UnZldYaEWFWTQMVZdU4roOIcNPa3yIYDLNywRo6vAmK5jbiug54PIgIoSXNJH/RmvXtgiB2JTEpwoXRVkSwtIUxLlXlM0hjeP65R/hI/SrEdUFAiSCuixUOo7xeku+cBK0R10WMyf5cF3Fzz1z/y9pya03CIC/DpAhPBKU0Amg7w+/c+ccUJTIoy8LyeFCWhfZ4UFoz7cb1JE+8jbju6DelNcqyUFbuqVT2WdiWi/hTtYhJ+fB45H06dfoMF/59F7Pu/zyp7m5I2+iAH2dwCE9ZKcnWdoJNc0Ep3KEYKuBHeSzcwRjpri68lRWYVJrQsiUM/+wNAg0NiOtinztHyfobssFuioFuyoRFBIwBrRl4YTcmkaD87rvof/Jp7Gg3uriYwd17Kf7w9cQPHya4YD5iDM6lAaxQCB0IkGxrI9DUhPJ6GPmvIwQXLSR18hS+GdWI42KfjzLrK39LqHkxxnXRljVejHeNKZu0iKAsC7FtdHGI8i2bsw1KY1/ow8TjWJFpmFQK36yZWOEwknFQWiOOg93Tgw4WMW3DDYSWNFOy7sPY0SiRm26k+Po1BOY2UnXvxwnMmY247pTz99RGF5aQloVJpsYaxDB86DCZCxfwzZiB2Dapjk7s7m68ZaXocAgrVITT34+x0wzseZn0qdNcenE3/vp63OE42uujeuu9XHppD+I42dw9NYOcOmEgm1M9HhSQ7upCKYWxbap+9+M4sWFGjh4j0dJCeOUKQBHbf4BEy3FQCisUxum/RPXWe/HV1hK5aSOptnZMMoU7PEyyrQNvWSnxI8eyVmHM+OXfE6ZMOB85RYTiNasZ+ul+jG3jmzEDq6QY7fVQ8xd/RskN6xg51oJJJqn6g09S8bGPovx+IrfcRHD+NXR9/R+xo90Em5oILV9G/MgR0tO0VE5Dde/Iywfbb0jFyU9c9+Sj53aIfkcc9P7he2Nwjb62XJkx+TQz0tEv7BCmF7g1yz87dlxE7Ko63PCw/OE3Y0yOa9n5Ph9IiUP7pReKBJ+M58+bs3HxYREcd1xBgzOrdWKu8rEPT4GcqMkMyk6E1eQllePMoi4aaZW72E/Vt+xHO3fpt7Gm8h6AvzROfL7Dl3kN+ffwdBy0/IV0Tr4GmebnuO3Xft5M65v8k3jj2KUoqz8R7wl9A+dAYRwW/5IDPC0f42Qt5ggcdB0klxbe1K9t/9FDs3fo3vntjF9NB0Wj7xE9r623kl+iYPHn+Cexd9lBc2P8Yz7c/TGevCFZevr/0if7/6s3zlze8Rs0ewdPZWJQ+dv1p1xRDyBPBbXtqGztCb6Ed8YQyCY1xKiypYW7OcFVWLKQtM47bZG/jyoW2cikW5s2Ejw5kElrJIOxmUJ8DS8nlsrF3B7PB0RIRTw+e5tn4drYOnAbJBxVfCvu4juVA5BttkqA5VsbbmOhaWzSFmjzCzpIYPlTUSCJZxMTXIsD3C8qrFrKhYiLL8pFwbx7gsLmvitvobQCkSTjrr73mlFpaWRgxBT4CqYBlv9J3ANhk84WqSTpoiT4CTA5184eC32H32ACLCJ5s+QrS/g9XVH6I8EGHESaHyaUkpuuK93LfgTnbd/E9EE330pwa5tW41Z4d7UEphmwyLaq6jpb+T/tQgHp1NUQABy8/JodP88MSTdMV7KfIESDs2rhhc42IpjVaapJMi7iQRxq6EE06SWGYkSy4fqArsZ5RwNrxbNJXMYm/XISoDpVQHy7HdDD7tYTA5wBPtL45qqLGkDuUN0lBcg4hgJHuTmV0h+/RoC4+2OBvvwRHh5tpVnBvpJeGkcIzDysoFKKB98AwBy5cXhYDl4+TAaf760HZOxs4R8Pizl/2XGX6WiGbsBCW5tFXYb3wGKChxFEYMjSV1HOxtoTwQIewtAmA4k2BxdTNdW1/l0wu3APDUqf9EjMOerkMIgt/yjvmKGIo8AV46+zqPtD5L98hFfAr8lo+Uk+R0LIpCURUspSZUyeDFVoIe/6gkQ3actTPX0Pupg6yvWc6QHcdSOpvbC1MR2Y0uvPJ1jTtaTzBaEE1g0kopHHFZVnENPbEuyvwl+LUXVLbNq70ABDx+lFI8feoV/mj5HxJN9NHS30mxNwQ518AYZoan81r3UR5++ylimRFOX+rk9j1/jsok6U70YWkLr/ZyfXUz2riX5dlscTFGzDUGn+XDoy20Urhici4YpNRfAgWVXqm/hIivGHLFi1IKkQKTLoxgg+kYM0PVgKI2VEnCTWG7GRTQcamTbx77F/75F8+wL3qElr4TfPW6TzOnuJaHTvwIhWLIjlPmLwEM29/6V17rOsSyivm8cv4NNjVs4tiWJygOVfJG3wmMGIbtETbVrsQoSDnpUTlSbpqka4+SaCiewZs9b/H9E0+SGu5h3rRZ1BfXsLP1xzzw88dBDKW+YjLG5bGOF/jS4R2EfSWU+EJZ0qMzg86biF97aS5roi5czYZZa5kfmc3CyBwqg2XMLZlFhS/E9pZ/47H2lzjQ+xa3N2yiIhjhvgWb6Yr3YmlNc9k8miKzePCGv+GbR35I3Elw/9KtJJ00d8zewKzwdG6v30DCSdM0bSbVReXUhatZXL+eikBkVKh50+qZH6nPmajhi8u2srxyAX+576vct+z3WFPdzD+s+hMG0jG2HX2EHeu+TOO0OlZWLuK16BEuJC7yzK3bCHr8l8cWQInJbsFEVUmh9gWFzjU5xsWTy28qZ2KqIBoqpUg66VG/zPfPl3vuOBPOX93k1y6UJb8GQDKTJOgNjpkqkHbSBHLrFPad6D9MUEuP2f0vdy5E4bDxixgKCvr8AeRXzDv+/0TI6WR0c/OHifym5TcwP0/+8FFYdOTbLjstvVe8m3GFfSbqP76dX6Hh8ePeCwo39Jc0fLXjvV01XAX4tSP83/djkKWkKgckAAAAAElFTkSuQmCC";

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"Content-Type":"application/json"}});
const LOGO_OMITTED_SEGMENT="iletwI5GSbzdStHC+Vn3maJJvz9BK/uC0ppEWxvDBw4TuWUT/ro6AOwLfVnyPh9Ka0wmQ6qjk+CC+ZAvQhwHcumHnNXkyRXm/alEaN4PwoXIC5npu8ilF3djFYcJzpvL0Kv7CC1dQsna67NmKcLFXU9Tec8WTC4QjRItSD3j31Xeh6dA+n0hLCLZk7BSl2lmaN/r9D/zY2b86WcINsyGnI+PtBxHFwWZtmH9Zf3fLaai5feFMBNoJn84SJ0+w9ArP0VZWVP2lpUTmNtIcME1KI9ndMyVgjLGSF5IQ1ZoS2mMCCIGrTRCQQ2b97lcv/w4jRp9ArhiUEawPB6c2DDJ9nasygqK6rNnZiPZ1bTSiGQjr85dIhgxl62nUQiCEUGr/ApgcnJZ+XFINpYoRVbK/BQF7xNpeNRf/hdM1G/8t4kqo4kC0v8Ek9v4PEQkt1lj48bPUzimsG1Uwxnj8PP+DvyWj4Wlc+hLDXBqqIu5kdmk3DTRkQtY2kPQ8hP0+Bm04ywtn8dAOkZXvIcZRZV0xXu4tnIBrhhe7TpEVaiK5vImRIQLiX7ODEdpKm0g4gvzTuwcQ3ac5ZULaB88Q8gbpDZUBcCp2Hn6U4NobRHIyXMydp7OSx2sqrmOab7srcnRi630Jy+xsW41Wmne6m8n42YoD0RoKKm9zM1G4biuiIh0x/uEh5dL6SPrRUTkr372kPC1Ynm09Vn5wqEdwrY64YFGmf7YzfK947uEhxZKyknLlw5/R1b/xydkZ8du4fvLJJFJyl17Py9srxf93cWyq/NlMcbIZw9sE74RkR";
const correctedLogoBase64=()=>LOGO_BASE64.slice(0,1536)+LOGO_OMITTED_SEGMENT+LOGO_BASE64.slice(1536);
const bytesFromBase64=(value:string)=>Uint8Array.from(atob(value),character=>character.charCodeAt(0));
const bytesToBase64=(value:Uint8Array)=>{let binary="";for(let offset=0;offset<value.length;offset+=8192)binary+=String.fromCharCode(...value.subarray(offset,offset+8192));return btoa(binary)};
const pacificDate=(value:string)=>new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",year:"numeric",month:"long",day:"numeric"}).format(new Date(value));
const pacificDateTime=(value:string)=>new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",dateStyle:"long",timeStyle:"short"}).format(new Date(value));
const safeError=(error:unknown)=>String((error as {message?:string})?.message||error||"Unknown delivery error").replace(/[\r\n]+/g," ").slice(0,500);

function wrapText(text:string,font:{widthOfTextAtSize:(value:string,size:number)=>number},size:number,maxWidth:number){
  const words=pdfText(text).split(/\s+/);const lines:string[]=[];let line="";
  for(const word of words){const next=line?`${line} ${word}`:word;if(font.widthOfTextAtSize(next,size)<=maxWidth)line=next;else{if(line)lines.push(line);line=word}}
  if(line)lines.push(line);return lines.length?lines:[""];
}

export async function buildReportPdf(run:ReportRun){
  const document=await PDFDocument.create();const regular=await document.embedFont(StandardFonts.Helvetica);const bold=await document.embedFont(StandardFonts.HelveticaBold);const logo=await document.embedPng(bytesFromBase64(correctedLogoBase64()));
  const pageSize:[number,number]=[612,792];let page=document.addPage(pageSize);let y=742;let pageNumber=1;
  const drawHeader=()=>{page.drawImage(logo,{x:48,y:700,width:80,height:60});page.drawText(pdfText("Reorder List"),{x:150,y:739,size:24,font:bold,color:rgb(.09,.30,.21)});page.drawText(pdfText(`Generated ${pacificDateTime(run.generated_at)} Pacific`),{x:150,y:718,size:10,font:regular,color:rgb(.35,.41,.37)});page.drawRectangle({x:48,y:675,width:516,height:24,color:rgb(.91,.95,.92)});page.drawText(pdfText("Product name"),{x:56,y:683,size:10,font:bold});page.drawText(pdfText("Category"),{x:358,y:683,size:10,font:bold});page.drawText(pdfText("Available"),{x:500,y:683,size:10,font:bold});y=667};
  const addPage=()=>{page.drawText(pdfText(`Page ${pageNumber}`),{x:510,y:26,size:9,font:regular,color:rgb(.4,.4,.4)});page=document.addPage(pageSize);pageNumber++;drawHeader()};
  drawHeader();
  for(const item of run.snapshot){const nameLines=wrapText(item.name,regular,10,282);const categoryLines=wrapText(item.category||"Uncategorized",regular,10,125);const rowHeight=Math.max(28,Math.max(nameLines.length,categoryLines.length)*13+10);if(y-rowHeight<48)addPage();page.drawLine({start:{x:48,y},end:{x:564,y},thickness:.5,color:rgb(.82,.85,.82)});nameLines.forEach((line,index)=>page.drawText(pdfText(line),{x:56,y:y-17-index*13,size:10,font:regular}));categoryLines.forEach((line,index)=>page.drawText(pdfText(line),{x:358,y:y-17-index*13,size:10,font:regular}));page.drawText(pdfText(String(item.available)),{x:525,y:y-17,size:11,font:bold});y-=rowHeight}
  page.drawLine({start:{x:48,y},end:{x:564,y},thickness:.5,color:rgb(.82,.85,.82)});page.drawText(pdfText(`Page ${pageNumber}`),{x:510,y:26,size:9,font:regular,color:rgb(.4,.4,.4)});
  return document.save();
}

function serviceKey(){const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(legacy)return legacy;const keys=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");return keys.default||Object.values(keys)[0]}
function publishableKey(){const legacy=Deno.env.get("SUPABASE_ANON_KEY");if(legacy)return legacy;const keys=JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}");return keys.default||Object.values(keys)[0]}
function clients(req:Request){const url=Deno.env.get("SUPABASE_URL")!;const auth=req.headers.get("Authorization")||"";return {user:createClient(url,String(publishableKey()),{global:{headers:{Authorization:auth}},auth:{persistSession:false}}),admin:createClient(url,String(serviceKey()),{auth:{persistSession:false}})}}
async function requireAdministrator(user:ReturnType<typeof createClient>){const {data,error}=await user.rpc("warehouse_reorder_get_admin_data");if(error)throw error;return data}

function transport(){const username=Deno.env.get("WAREHOUSE_GMAIL_USER");const password=Deno.env.get("WAREHOUSE_GMAIL_APP_PASSWORD");if(!username||!password)throw new Error("Gmail report secrets are not configured");return nodemailer.createTransport({host:"smtp.gmail.com",port:465,secure:true,auth:{user:username,pass:password},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000})}
const uncertainFailure=(error:unknown)=>/timeout|timed out|etimedout|socket closed|connection closed/i.test(safeError(error));
async function sendRecipient(mail:ReturnType<typeof nodemailer.createTransport>,run:ReportRun,recipient:string,pdf?:Uint8Array){let attempts=0;while(attempts<3){attempts++;try{const result=await mail.sendMail({from:{name:"Habaneros Warehouse",address:Deno.env.get("WAREHOUSE_GMAIL_USER")!},to:recipient,subject:`Habaneros Reorder List - ${pacificDate(run.generated_at)}`,text:run.item_count?`Attached is the Habaneros Reorder List generated ${pacificDateTime(run.generated_at)} Pacific.`:"No items need reordering.",attachments:pdf?[{filename:`habaneros-reorder-list-${new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles"}).format(new Date(run.generated_at))}.pdf`,content:pdf,contentType:"application/pdf"}]:[]});if(result.accepted?.map(String).some(value=>value.toLowerCase()===recipient.toLowerCase()))return {status:"accepted",attempts,error:null};throw new Error(`Gmail rejected recipient (${result.response||"no response"})`)}catch(error){if(uncertainFailure(error))return {status:"uncertain",attempts,error:"SMTP outcome uncertain after a connection timeout"};if(attempts>=3)return {status:"failed",attempts,error:safeError(error)};await new Promise(resolve=>setTimeout(resolve,250*attempts))}}return {status:"failed",attempts,error:"Delivery failed"}}
async function dispatch(run:ReportRun,admin:ReturnType<typeof createClient>){const pdf=run.item_count?await buildReportPdf(run):undefined;const mail=transport();for(const recipient of run.recipients){const result=await sendRecipient(mail,run,recipient,pdf);const {error}=await admin.rpc("warehouse_reorder_record_delivery",{input_run_id:run.id,input_recipient:recipient,input_status:result.status,input_attempts:result.attempts,input_safe_error:result.error});if(error)throw error}const {data,error}=await admin.rpc("warehouse_reorder_finish_run",{input_run_id:run.id});if(error)throw error;return data}

Deno.serve(async req=>{
  // Preflight must complete before body parsing, Supabase client creation, or
  // administrator/scheduler authorization.
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(req.method!=="POST")return json({error:"Method not allowed"},405);
  try{
    const body=await req.json().catch(()=>({}));const action=String(body.action||"");const {user,admin}=clients(req);
    if(action==="scheduled"){
      const supplied=req.headers.get("x-reorder-scheduler-secret")||"";const expected=Deno.env.get("REORDER_SCHEDULER_SECRET")||"";if(!expected||supplied!==expected)return json({error:"Unauthorized"},401);
      const {data,error}=await admin.rpc("warehouse_reorder_claim_scheduled",{input_now:new Date().toISOString()});if(error)throw error;if(!data)return json({claimed:false});const status=await dispatch(data as ReportRun,admin);return json({claimed:true,run_id:data.id,status});
    }
    await requireAdministrator(user);
    if(action==="preview"){
      const {data,error}=await user.rpc("warehouse_reorder_create_preview");if(error)throw error;const run=data as ReportRun;const pdf=run.item_count?await buildReportPdf(run):undefined;return json({...run,pdf_base64:pdf?bytesToBase64(pdf):null,empty_message:run.item_count?null:"No items need reordering."});
    }
    if(action==="confirm"){
      const {data,error}=await user.rpc("warehouse_reorder_claim_manual",{input_run_id:body.run_id});if(error)throw error;const run=data as ReportRun;if(!run.claimed)return json(run);const status=await dispatch(run,admin);return json({claimed:true,run_id:run.id,status});
    }
    if(action==="test-connection"){await transport().verify();return json({connected:true,message:"Gmail accepted the authenticated SMTP connection; no email was sent."})}
    return json({error:"Unknown action"},400);
  }catch(error){return json({error:safeError(error)},400)}
});
