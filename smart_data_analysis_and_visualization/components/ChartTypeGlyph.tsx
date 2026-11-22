"use client";

import type { ReactNode } from "react";
import type { CustomChart } from "../lib/intelligence";

// Individual chart-shaped thumbnails. Drawn as lightweight inline SVG so their
// shapes and QueryPilot colors remain consistent at every screen size.
export default function ChartTypeGlyph({chart, size=34}: {chart:CustomChart;size?:number}) {
 const navy="#131B2B", slate="#2F4A63", teal="#5B91A3", mint="#CFEAE0";
 let artwork:ReactNode;
 const baseline=<path d="M5 40H43" stroke={slate} strokeWidth="1.5"/>;
 switch(chart) {
 case "bar": artwork=<>{baseline}{[0,1,2].map((i)=><rect key={i} x="8" y={9+11*i} width={[31,20,26][i]} height="7" rx="1.5" fill={[teal,slate,mint][i]} stroke="none"/>)}</>;break;
 case "column": artwork=<>{baseline}{[14,26,37,22].map((h,i)=><rect key={i} x={8+9*i} y={40-h} width="6.5" height={h} rx="1.3" fill={i%2?slate:teal} stroke="none"/>)}</>;break;
 case "grouped_bar": artwork=<>{baseline}{[0,1,2].map(i=><g key={i}><rect x={8+13*i} y={19+i*2} width="5" height={21-i*2} rx="1" fill={slate}/><rect x={14+13*i} y={12+i*3} width="5" height={28-i*3} rx="1" fill={teal}/></g>)}</>;break;
 case "stacked_bar": artwork=<>{baseline}{[0,1,2].map(i=><g key={i}><rect x={9+i*12} y={25-i*3} width="8" height={15+i*3} fill={slate}/><rect x={9+i*12} y={12+i*3} width="8" height={13-i*0} fill={teal}/></g>)}</>;break;
 case "stacked_100": artwork=<>{baseline}{[0,1,2].map(i=><g key={i}><rect x={9+i*12} y="27" width="8" height="13" fill={slate}/><rect x={9+i*12} y={13+i*2} width="8" height={14-i*2} fill={teal}/><rect x={9+i*12} y="7" width="8" height={6+i*2} fill={mint}/></g>)}</>;break;
 case "bullet": artwork=<><rect x="5" y="16" width="38" height="17" rx="2" fill={mint}/><rect x="5" y="21" width="27" height="7" rx="1" fill={teal}/><path d="M36 11V39" strokeWidth="3"/>{baseline}</>;break;
 case "lollipop": artwork=<>{[12,24,36].map((y,i)=><g key={i}><path d={"M8 "+y+" H"+[34,25,39][i]} stroke={teal} strokeWidth="2.5"/><circle cx={[34,25,39][i]} cy={y} r="4" fill={slate} stroke="none"/></g>)}</>;break;
 case "line": artwork=<>{baseline}<path d="M7 32L17 22L25 28L35 11L42 17" stroke={teal} strokeWidth="3" strokeLinejoin="round"/>{[[7,32],[17,22],[25,28],[35,11],[42,17]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="2" fill={navy} stroke="none"/>)}</>;break;
 case "area": artwork=<>{baseline}<path d="M7 33L16 26L24 30L33 12L42 19V40H7Z" fill={mint} stroke="none"/><path d="M7 33L16 26L24 30L33 12L42 19" stroke={teal} strokeWidth="2.5"/></>;break;
 case "stacked_area": artwork=<>{baseline}<path d="M6 31L16 27L24 33L34 24L43 26V40H6Z" fill={slate} stroke="none"/><path d="M6 19L16 13L24 18L34 9L43 15V26L34 24L24 33L16 27L6 31Z" fill={teal} stroke="none"/><path d="M6 19L16 13L24 18L34 9L43 15" stroke={navy} strokeWidth="1.8"/></>;break;
 case "sparkline": artwork=<><rect x="4" y="9" width="40" height="30" rx="5" stroke={mint} strokeWidth="1.5"/><path d="M8 31L15 26L21 29L29 16L35 21L41 12" stroke={teal} strokeWidth="3"/><circle cx="41" cy="12" r="2.8" fill={navy} stroke="none"/></>;break;
 case "combo": artwork=<>{baseline}{[15,24,18,31].map((h,i)=><rect key={i} x={8+10*i} y={40-h} width="6" height={h} fill={i%2?mint:teal} stroke="none"/>)}<path d="M10 19L21 25L30 10L41 15" stroke={navy} strokeWidth="2.8"/></>;break;
 case "pie": artwork=<><circle cx="24" cy="24" r="17" fill={mint} stroke="none"/><path d="M24 24V7A17 17 0 0 1 40 30Z" fill={teal} stroke="none"/><path d="M24 24L40 30A17 17 0 0 1 12 36Z" fill={slate} stroke="none"/><circle cx="24" cy="24" r="17" strokeWidth="1.4"/></>;break;
 case "donut": artwork=<><circle cx="24" cy="24" r="16" stroke={mint} strokeWidth="10"/><path d="M24 8A16 16 0 0 1 39 30" stroke={teal} strokeWidth="10"/><path d="M39 30A16 16 0 0 1 13 35" stroke={slate} strokeWidth="10"/><circle cx="24" cy="24" r="7" fill="#fff" stroke="none"/></>;break;
 case "treemap": artwork=<><rect x="5" y="6" width="38" height="35" rx="2" strokeWidth="1.4"/><rect x="7" y="8" width="19" height="31" fill={teal} stroke="none"/><rect x="28" y="8" width="13" height="17" fill={slate} stroke="none"/><rect x="28" y="27" width="8" height="12" fill={mint} stroke="none"/><rect x="38" y="27" width="3" height="12" fill={teal} stroke="none"/></>;break;
 case "waffle": artwork=<>{Array.from({length:25},(_,i)=><rect key={i} x={5+(i%5)*8} y={5+Math.floor(i/5)*8} width="6.5" height="6.5" rx="1" fill={i<10?slate:i<19?teal:mint} stroke="none"/>)}</>;break;
 case "histogram": artwork=<>{baseline}{[7,13,24,33,25,14,7].map((h,i)=><rect key={i} x={6+i*5.2} y={40-h} width="5.2" height={h} fill={i>2&&i<5?slate:teal} stroke="none"/>)}</>;break;
 case "box": artwork=<><path d="M24 5V43M15 5H33M15 43H33" stroke={slate} strokeWidth="2"/><rect x="13" y="14" width="22" height="21" rx="2" fill={mint} stroke={teal} strokeWidth="2"/><path d="M13 24H35" strokeWidth="3"/></>;break;
 case "violin": artwork=<><path d="M24 5C17 12 15 17 18 23C21 30 10 33 24 43C38 33 27 30 30 23C33 17 31 12 24 5Z" fill={mint} stroke={teal} strokeWidth="2"/><path d="M24 5V43" stroke={slate} strokeDasharray="2 4"/><path d="M17 25H31" strokeWidth="2.5"/></>;break;
 case "density": artwork=<>{baseline}<path d="M6 39C13 39 15 24 21 16C27 8 29 11 33 19C37 28 39 39 43 39V40H6Z" fill={mint} stroke="none"/><path d="M6 39C13 39 15 24 21 16C27 8 29 11 33 19C37 28 39 39 43 39" stroke={teal} strokeWidth="2.7"/></>;break;
 case "scatter": artwork=<>{baseline}{[[11,33],[15,26],[21,30],[25,19],[30,25],[33,15],[40,11],[18,37]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="2.6" fill={i%2?teal:slate} stroke="none"/>)}</>;break;
 case "bubble": artwork=<>{baseline}<circle cx="14" cy="32" r="4.5" fill={mint} stroke={slate}/><circle cx="27" cy="23" r="8" fill={teal} stroke={slate}/><circle cx="40" cy="12" r="4" fill={slate} stroke="none"/><circle cx="39" cy="34" r="3" fill={mint} stroke={slate}/></>;break;
 case "heatmap": artwork=<>{Array.from({length:16},(_,i)=><rect key={i} x={5+(i%4)*10} y={5+Math.floor(i/4)*10} width="8" height="8" rx="1.2" fill={[mint,teal,slate,teal,teal,mint,slate,mint,slate,teal,mint,slate,mint,slate,teal,mint][i]} stroke="none"/>)}</>;break;
 case "correlation": artwork=<>{Array.from({length:16},(_,i)=>{const r=Math.floor(i/4),c=i%4;return <rect key={i} x={5+c*10} y={5+r*10} width="8" height="8" rx="1" fill={r===c?navy:Math.abs(r-c)===1?teal:mint} stroke="none"/>;})}</>;break;
 case "kpi": artwork=<><rect x="5" y="7" width="38" height="34" rx="5" stroke={mint} strokeWidth="2"/><text x="8" y="29" fill={slate} stroke="none" fontSize="18" fontWeight="800" fontFamily="Arial, sans-serif">123</text><path d="M32 35l4-4 3 2 3-6" stroke={teal} strokeWidth="2.1"/></>;break;
 case "gauge": artwork=<><path d="M8 36A17 17 0 0 1 40 36" stroke={mint} strokeWidth="6"/><path d="M8 36A17 17 0 0 1 27 9" stroke={teal} strokeWidth="6"/><path d="M24 35L33 18" strokeWidth="2.5"/><circle cx="24" cy="35" r="3.3" fill={navy} stroke="none"/></>;break;
 case "progress": artwork=<><rect x="5" y="12" width="38" height="9" rx="4.5" fill={mint} stroke="none"/><rect x="5" y="12" width="27" height="9" rx="4.5" fill={teal} stroke="none"/><rect x="5" y="28" width="38" height="9" rx="4.5" fill={mint} stroke="none"/><rect x="5" y="28" width="19" height="9" rx="4.5" fill={slate} stroke="none"/></>;break;
 case "thermometer": artwork=<><rect x="18" y="5" width="12" height="32" rx="6" fill={mint} stroke={slate} strokeWidth="2"/><rect x="22" y="15" width="4" height="23" rx="2" fill={teal} stroke="none"/><circle cx="24" cy="38" r="7" fill={teal} stroke={slate} strokeWidth="2"/></>;break;
 case "funnel": artwork=<><path d="M5 8H43L33 19H15Z" fill={teal} stroke="none"/><path d="M15 22H33L28 31H20Z" fill={slate} stroke="none"/><path d="M20 34H28L25 42H23Z" fill={mint} stroke={slate} strokeWidth="1"/></>;break;
 case "waterfall": artwork=<>{baseline}<rect x="7" y="23" width="7" height="17" rx="1" fill={teal} stroke="none"/><rect x="18" y="12" width="7" height="11" rx="1" fill={teal} stroke="none"/><rect x="29" y="12" width="7" height="16" rx="1" fill={slate} stroke="none"/><rect x="39" y="23" width="5" height="17" rx="1" fill={mint} stroke="none"/><path d="M14 23H18M25 12H29M36 28H39" stroke={slate} strokeDasharray="2 2"/></>;break;
 case "sankey": artwork=<><path d="M6 9C20 9 27 35 43 35M6 24C19 24 31 9 43 9M6 39C18 39 28 24 43 24" stroke={teal} strokeWidth="6" strokeOpacity=".72"/><path d="M6 9V40M43 9V36" stroke={slate} strokeWidth="4"/></>;break;
 case "slope": artwork=<><path d="M7 40V8M42 40V8" stroke={mint} strokeWidth="2"/><path d="M8 33L41 12" stroke={teal} strokeWidth="2.8"/><path d="M8 15L41 29" stroke={slate} strokeWidth="2.8"/>{[[8,33],[41,12],[8,15],[41,29]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="3.2" fill={i<2?teal:slate} stroke="none"/>)}</>;break;
 case "bump": artwork=<><path d="M5 7V41H44" strokeWidth="1.5"/><path d="M8 12L19 23L30 12L42 30" stroke={teal} strokeWidth="2.6"/><path d="M8 35L19 17L30 33L42 10" stroke={slate} strokeWidth="2.6"/><path d="M8 24L19 35L30 22L42 22" stroke={mint} strokeWidth="2.6"/></>;break;
 case "radar": artwork=<><path d="M24 5L42 18L35 41H13L6 18Z" stroke={mint} strokeWidth="1.6"/><path d="M24 5V41M6 18L35 41M42 18L13 41" stroke={mint}/><path d="M24 12L35 21L30 34L16 32L12 20Z" fill={teal} fillOpacity=".44" stroke={slate} strokeWidth="2"/></>;break;
 case "parallel": artwork=<><path d="M9 5V42M19 5V42M29 5V42M39 5V42" stroke={mint} strokeWidth="2"/><path d="M9 12L19 30L29 14L39 23" stroke={teal} strokeWidth="2.4"/><path d="M9 33L19 14L29 31L39 11" stroke={slate} strokeWidth="2.4"/></>;break;
 case "network": artwork=<><path d="M10 10L25 7L40 17L31 38L9 34Z M10 10L31 38M25 7L9 34M40 17L9 34" stroke={teal} strokeWidth="1.7"/>{[[10,10],[25,7],[40,17],[31,38],[9,34]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="4" fill={i%2?teal:slate} stroke="none"/>)}</>;break;
 case "table": artwork=<><rect x="5" y="7" width="38" height="34" rx="3" strokeWidth="1.5"/><rect x="6" y="8" width="36" height="9" fill={slate} stroke="none"/><path d="M6 25H42M6 33H42M19 17V40M31 17V40" stroke={teal} strokeWidth="1.5"/></>;break;
 case "pivot": artwork=<><rect x="5" y="7" width="38" height="34" rx="3" strokeWidth="1.5"/><rect x="6" y="8" width="36" height="9" fill={teal} stroke="none"/><rect x="6" y="17" width="11" height="23" fill={mint} stroke="none"/><path d="M17 17V41M29 17V41M5 25H43M5 33H43" stroke={slate} strokeWidth="1.6"/><path d="M34 22L39 26L34 30" stroke={navy} strokeWidth="1.6"/></>;break;
 default: artwork=<><circle cx="24" cy="24" r="15" stroke={teal} strokeWidth="2"/><path d="M14 29L22 21L29 26L36 16" stroke={slate} strokeWidth="2.5"/></>;
 }
 return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" stroke={navy}
   strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" role="img"
   aria-label={chart.replace(/_/g," ")+" chart symbol"} focusable="false">{artwork}</svg>;
}
