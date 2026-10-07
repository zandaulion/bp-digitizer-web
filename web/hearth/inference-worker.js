// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 zandaulion
// Full browser pipeline and message contract: docs/API_REFERENCE.md.
// Owns/closes transferred bitmaps; one read at a time. Config fallback blocks
// describe the implementation; crop geometry/fractions are currently code constants.
import * as ort from './vendor/ort.wasm.min.mjs';
import {assemble,decodeOutput,isPlausibleReading} from './reading.js';
import {cropRegions,selectCropFallback} from './crop-fallback.js';
import {rowRegion,normalizeRgba,selectAdaptiveFallback} from './adaptive-crop.js';

ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;
ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
let session,digitSession,config,busy=false;
const initialized=(async()=>{
  config=await (await fetch('./models/config.json')).json();
  session=await ort.InferenceSession.create('./models/bp-detector.onnx',{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  digitSession=await ort.InferenceSession.create('./models/bp-digits.onnx',{executionProviders:['wasm'],graphOptimizationLevel:'all'});
  self.postMessage({type:'ready',size:config.size});
})().catch(error=>{self.postMessage({type:'error',message:`Unable to load the local reader: ${error.message}`});throw error;});

async function infer(bitmap){
    const size=config.size;
    const scale=Math.min(size/bitmap.width,size/bitmap.height);
    const width=Math.round(bitmap.width*scale),height=Math.round(bitmap.height*scale);
    const left=Math.floor((size-width)/2),top=Math.floor((size-height)/2);
    const canvas=new OffscreenCanvas(size,size),ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.fillStyle='rgb(114,114,114)';ctx.fillRect(0,0,size,size);
    ctx.drawImage(bitmap,left,top,width,height);
    const rgba=ctx.getImageData(0,0,size,size).data;
    const pixels=size*size,input=new Float32Array(3*pixels);
    for(let i=0;i<pixels;i++){input[i]=rgba[4*i]/255;input[pixels+i]=rgba[4*i+1]/255;input[2*pixels+i]=rgba[4*i+2]/255;}
    const output=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',input,[1,3,size,size])});
    const tensor=output[session.outputNames[0]];
    const transform={scale,left,top,width:bitmap.width,height:bitmap.height};
    let detections=decodeOutput(tensor.data,tensor.dims,transform,config.minScore);
    const digits=detections.filter(d=>d.class!=='row');
    if(digits.length){
      const batch=new Float32Array(digits.length*32*48),cropCanvas=new OffscreenCanvas(32,48),cropCtx=cropCanvas.getContext('2d',{willReadFrequently:true});
      for(const [index,d] of digits.entries()){
        const [x1,y1,x2,y2]=d.box;const sx=Math.max(0,Math.floor(x1)),sy=Math.max(0,Math.floor(y1)),sw=Math.min(bitmap.width,Math.ceil(x2))-sx,sh=Math.min(bitmap.height,Math.ceil(y2))-sy;
        cropCtx.clearRect(0,0,32,48);cropCtx.drawImage(bitmap,sx,sy,sw,sh,0,0,32,48);
        const rgba=cropCtx.getImageData(0,0,32,48).data,gray=new Float32Array(32*48);let sum=0;
        for(let i=0;i<gray.length;i++){gray[i]=Math.round(.299*rgba[4*i]+.587*rgba[4*i+1]+.114*rgba[4*i+2]);sum+=gray[i];}
        const mean=sum/gray.length;let variance=0;for(const value of gray)variance+=(value-mean)**2;
        const std=Math.max(12,Math.sqrt(variance/gray.length));
        for(let i=0;i<gray.length;i++)batch[index*gray.length+i]=(gray[i]-mean)/std;
      }
      const cropOutput=await digitSession.run({[digitSession.inputNames[0]]:new ort.Tensor('float32',batch,[digits.length,1,48,32])});
      const logits=cropOutput[digitSession.outputNames[0]].data;
      const refined=detections.filter(d=>d.class==='row');
      for(const [i,d] of digits.entries()){
        const values=Array.from(logits.slice(i*11,(i+1)*11));const max=Math.max(...values),exp=values.map(v=>Math.exp(v-max)),sum=exp.reduce((a,b)=>a+b,0),cid=values.indexOf(max),confidence=exp[cid]/sum;
        if(cid!==10&&confidence>=config.digitMinScore)refined.push({...d,class:String(cid),detector_class:d.class,recognition_score:confidence,score:Math.min(d.score,confidence)});
      }
      detections=refined;
    }
    return assemble(detections,config.minScore,config.acceptScore);
}

self.onmessage=async({data})=>{
  if(data.type!=='read')return;
  const {bitmap,id}=data;
  if(busy){bitmap.close();self.postMessage({type:'error',id,message:'The reader is processing another photo.'});return;}
  busy=true;
  try{
    await initialized;
    const started=performance.now();
    let result=await infer(bitmap);
    const full=result;
    if(!isPlausibleReading(result.reading)){
      const replays=[];
      for(const {name,rect} of cropRegions(bitmap.width,bitmap.height)){
        const crop=await createImageBitmap(bitmap,...rect);
        try{replays.push({name,rect,result:await infer(crop)});}finally{crop.close();}
      }
      result=selectCropFallback(result,replays);
    }
    if(!isPlausibleReading(result.reading)){
      const rect=rowRegion(full.detections,bitmap.width,bitmap.height);
      if(rect){
        const [x,y,width,height]=rect;
        const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});
        ctx.drawImage(bitmap,x,y,width,height,0,0,width,height);
        const rgba=ctx.getImageData(0,0,width,height).data,replays=[];
        for(const fraction of [.04,.05]){
          ctx.putImageData(new ImageData(normalizeRgba(rgba,width,height,fraction),width,height),0,0);
          replays.push({name:'normalized-'+fraction,rect,result:await infer(canvas)});
        }
        const selected=selectAdaptiveFallback(full,replays);
        if(selected!==full){
          selected.cropFallback.method='two-agreeing-row-crops-light-normalized';
          result=selected;
        }
      }
    }
    self.postMessage({type:'result',id,result,elapsedMs:Math.round(performance.now()-started)});
  }catch(error){self.postMessage({type:'error',id,message:error.message});}
  finally{bitmap.close();busy=false;}
};
