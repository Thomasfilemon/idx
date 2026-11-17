const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat("id-ID", {maximumFractionDigits:2});
const money = (n) => n == null ? "—" : "Rp" + fmt.format(n);
const number = (n) => n == null ? "—" : fmt.format(n);
const date = (value) => {if(!value)return "—";const d=new Date(value);return Number.isNaN(d.getTime())?String(value):new Intl.DateTimeFormat("id-ID",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Jakarta"}).format(d)+" WIB"};
const sample = [
{symbol:"BBCA",name:"PT Bank Central Asia Tbk",price:5500,change:25,change_pct:.456621,volume:218808600,market_time:"2026-11-13T09:14:00Z"},
{symbol:"BBRI",name:"PT Bank Rakyat Indonesia Tbk",price:3060,change:30,change_pct:.990099,volume:371986900,market_time:"2026-11-13T09:14:00Z"},
{symbol:"TLKM",name:"PT Telkom Indonesia Tbk",price:2160,change:null,change_pct:null,volume:null,market_time:"2026-11-13T09:14:00Z"}
];
let mode="demo",symbols=["BBCA","BBRI","TLKM"],rows=sample,selected="BBCA",source="Sample data · 13 Nov 2026",market=null;
const signed=(n,unit="")=>n==null?"—":(n>0?"+":"")+fmt.format(n)+unit;
const cls=(n)=>n>0?"positive":n<0?"negative":"";
function render(){
  $("stocks").replaceChildren(...symbols.map(s=>{
    const q=rows.find(x=>x.symbol===s);const b=document.createElement("button");b.type="button";b.className="stock"+(s===selected?" selected":"");
    const left=document.createElement("div"),right=document.createElement("div");right.className="stock-right";
    const ticker=document.createElement("div");ticker.className="ticker";ticker.textContent=s;
    const company=document.createElement("div");company.className="company";company.textContent=q?.name||"Belum ada data";
    const price=document.createElement("div");price.className="price";price.textContent=money(q?.price);
    const change=document.createElement("div");change.className="change "+cls(q?.change_pct);change.textContent=signed(q?.change_pct,"%");
    left.append(ticker,company);right.append(price,change);b.append(left,right);b.addEventListener("click",()=>{selected=s;render()});return b;
  }));
  const q=rows.find(x=>x.symbol===selected);
  $("detail-title").textContent=selected+" · Detail saham";$("detail-name").textContent=q?.name||"Data tidak tersedia";
  $("detail-source").textContent=source;$("detail-price").textContent=money(q?.price);
  $("detail-change").textContent=signed(q?.change)+" ("+signed(q?.change_pct,"%")+")";
  $("detail-change").className=cls(q?.change_pct);
  $("detail-volume").textContent=number(q?.volume);$("detail-time").textContent=date(q?.market_time);
  $("mode").textContent=mode==="demo"?"Demo data":"Live API";
  $("demo").classList.toggle("active",mode==="demo");$("live").classList.toggle("active",mode==="live");
  const ix=market?.index;$("ihsg").textContent=ix?.price==null?"—":fmt.format(ix.price);
  $("ihsg-change").textContent=ix?.change_pct==null?"Belum ada data IHSG":signed(ix.change)+" ("+signed(ix.change_pct,"%")+")";
  $("ihsg-change").className="delta "+cls(ix?.change_pct);
  $("market-status").textContent=market?market.market_open?"Market open":"Market closed":"Market status belum tersedia";
  $("updated").textContent=market?.as_of?"Market: "+date(market.as_of):"—";
}
async function get(path){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);try{const r=await fetch(path,{signal:controller.signal,headers:{Accept:"application/json"}});if(!r.ok)throw Error("HTTP "+r.status);const v=await r.json();if(v.error)throw Error(v.error.message||"API error");return v}finally{clearTimeout(timer)}}
async function load(){
  if(mode==="demo"){rows=sample;market=null;source="Sample data · 13 Nov 2026";$("notice").textContent="Demo memakai sample dari smoke test 16 Nov 2026; bukan harga terkini.";render();return}
  $("notice").textContent="Mengambil data dari backend IDX…";
  try{
    const [m,q]=await Promise.all([get("/api/market"),get("/api/quote?symbols="+encodeURIComponent(symbols.join(",")))]);
    if(!Array.isArray(q.data))throw Error("Format quote tidak sesuai");
    rows=q.data;market=m.data;source=(q.provider||"API")+" · "+(q.stale?"stale":"latest available");
    const missing=symbols.filter(s=>!rows.some(q=>q.symbol===s));
    $("notice").textContent="Data provider: "+(q.provider||"—")+" · fetched "+date(q.fetched_at)+(q.stale?" · STALE":"")+(missing.length?" · Tidak ditemukan: "+missing.join(", "):"");
  }catch(e){rows=[];market=null;source="Live API tidak tersedia";$("notice").textContent="Gagal mengambil data: "+e.message+". Pastikan dashboard dan API disajikan pada host yang sama. Tidak mengganti live data dengan sample diam-diam."}
  render();
}
$("demo").addEventListener("click",()=>{mode="demo";load()});$("live").addEventListener("click",()=>{mode="live";load()});$("refresh").addEventListener("click",load);
$("add").addEventListener("click",()=>{const s=$("symbol").value.trim().toUpperCase().replace(/\.JK$/,"");if(!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(s)){$("notice").textContent="Masukkan ticker yang valid, misalnya ASII.";return}if(!symbols.includes(s))symbols.push(s);selected=s;$("symbol").value="";load()});
$("symbol").addEventListener("keydown",(e)=>{if(e.key==="Enter")$("add").click()});
load();
