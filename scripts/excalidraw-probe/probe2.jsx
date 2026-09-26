import React from "react"; import {createRoot} from "react-dom/client";
import {Excalidraw, restore, serializeAsJSON} from "@excalidraw/excalidraw";
fetch("/ground.excalidraw").then(r=>r.json()).then(file=>{
  const data = restore(file, null, null);
  window.__restored = { n: data.elements.length, types: data.elements.map(e=>e.type), bound: data.elements.filter(e=>e.type==="arrow").map(e=>[e.startBinding?.elementId, e.endBinding?.elementId]), bg: data.appState.viewBackgroundColor, roundtrip: JSON.parse(serializeAsJSON(data.elements, data.appState, {}, "local")).elements.length };
  createRoot(document.getElementById("root")).render(<div style={{height:"100vh"}}><Excalidraw initialData={{...data, scrollToContent:true}} /></div>);
});
