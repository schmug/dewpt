import React from "react"; import {createRoot} from "react-dom/client";
import {Excalidraw, convertToExcalidrawElements, FONT_FAMILY} from "@excalidraw/excalidraw";
const theme = new URLSearchParams(location.search).get("theme") || "light";
const ff = FONT_FAMILY[new URLSearchParams(location.search).get("font") || "Excalifont"];
const t = (id,x,y,text,color,size=28)=>({type:"text",id,x,y,text,strokeColor:color,fontSize:size,fontFamily:ff});
const els = convertToExcalidrawElements([
  t("a",120,160,"night buses","#e8c170"), t("b",140,220,"last train home","#e8c170"),
  t("c",620,180,"turnstile design","#e8c170"), t("d",600,240,"fare evasion","#e8c170"),
  t("e",380,420,"vapor: station murals","#b9a6e8",22),
  {type:"arrow",x:300,y:200,width:290,height:0,strokeColor:"#8f89b8",start:{id:"b"},end:{id:"c"}},
  
]);
createRoot(document.getElementById("root")).render(
  <div style={{height:"100vh"}}><Excalidraw theme={theme} zenModeEnabled viewModeEnabled={false}
    UIOptions={{canvasActions:{changeViewBackgroundColor:false,export:false,loadScene:false,saveToActiveFile:false,toggleTheme:false,clearCanvas:false}}}
    initialData={{elements:els, appState:{viewBackgroundColor:"#0d0c14"}, scrollToContent:true}} /></div>);
