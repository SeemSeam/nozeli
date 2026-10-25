// Independent host-side expected outputs. No production summarizer is copied
// here; expected values are fixed, including the symmetric stress case.
const csv=rows=>'device,sample,time,reading,quality\n'+rows.map(row=>row.join(',')).join('\n')+'\n';
const group=(device,day,count,mean,min,max)=>({device,day,count,mean,min,max});
export const calibration={A:1.5,B:-2};
export const primaryRows=[
 ['A','a0','2026-01-01T15:58:00Z','-5','ok'],
 ['A','a1','2026-01-01T15:59:00Z','10','ok'],
 ['A','a1','2026-01-01T16:01:00Z','12','ok'],
 ['A','a1','2026-01-01T16:02:00Z','','ok'],
 ['A','a2','2026-01-02T00:30:00+08:00','0','ok'],
 ['A','a3','2026-01-02T01:00:00+08:00','86','ok'],
 ['A','a4','2026-01-03T00:15:00','','ok'],
 ['A','a5','not-a-date','20','ok'],
 ['B','b0','2026-01-01T16:00:00Z','-40','ok'],
 ['B','b1','2026-01-02T01:00:00+08:00','85','ok'],
 ['B','b2','2026-01-02T02:00:00+08:00','5','bad'],
 ['B','b3','2026-01-02T04:00:00+08:00','1','ok'],
 ['B','b3','2026-01-02T03:00:00+08:00','3','ok'],
 ['B','b3','2026-01-02T05:00:00+08:00','900','ok'],
 ['C','c0','2026-01-01T16:00:00Z','7','ok'],
 ['C','c1','2026-01-02T05:00:00','-2','ok'],
];
export function reasoningCases(){
 const stress=[];for(const device of ['A','B'])for(let i=0;i<100;i++)stress.push([device,'s'+i,'2026-08-01T00:00:00',String(i%5-2),'ok']);
 const stressExpected=[group('A','2026-08-01',100,1.5,-0.5,3.5),group('B','2026-08-01',100,-2,-4,0)];
 return [
  {name:'primary-conflicts-and-null-days',input:csv(primaryRows),expected:[group('A','2026-01-01',1,-3.5,-3.5,-3.5),group('A','2026-01-02',2,7.5,1.5,13.5),group('A','2026-01-03',0,null,null,null),group('B','2026-01-02',3,14,-42,83),group('C','2026-01-02',2,2.5,-2,7)]},
  {name:'raw-bounds-before-calibration',input:csv([['A','x1','2026-02-28T16:00:00Z','-40','ok'],['A','x2','2026-03-01T00:00:00+08:00','85','ok'],['A','x3','not-a-date','0','ok']]),expected:[group('A','2026-03-01',2,24,-38.5,86.5)]},
  {name:'all-invalid-duplicate-uses-last-valid-time',input:csv([['B','dup','2026-03-01T00:00:00+08:00','','ok'],['B','dup','2026-03-02T00:00:00+08:00','NaN','ok'],['B','y','2026-03-02T01:00:00+08:00','0','bad']]),expected:[group('B','2026-03-02',0,null,null,null)]},
  {name:'last-valid-input-order-not-measurement-order',input:csv([['C','same','2026-04-01T16:00:00Z','1','ok'],['C','same','2026-04-01T23:00:00','2','ok'],['C','same','bad-time','4','ok'],['C','other','2026-04-01T22:00:00+08:00','0','ok']]),expected:[group('C','2026-04-01',2,1,0,2)]},
  {name:'duplicate-key-includes-device',input:csv([['A','shared','2026-05-01T00:00:00','0','ok'],['B','shared','2026-05-01T00:00:00','0','ok'],['C','shared','2026-05-01T00:00:00','0','ok'],['A','other','2026-05-01T01:00:00','-1','ok']]),expected:[group('A','2026-05-01',2,1,0.5,1.5),group('B','2026-05-01',1,-2,-2,-2),group('C','2026-05-01',1,0,0,0)]},
  {name:'nonfinite-empty-range-and-quality-case',input:csv([['A','i1','2026-06-01T00:00:00','Infinity','ok'],['A','i2','2026-06-01T00:01:00',' ','ok'],['A','i3','2026-06-01T00:02:00','5','OK'],['A','i4','2026-06-01T00:03:00','-40.001','ok'],['A','i5','2026-06-01T00:04:00','85.001','ok']]),expected:[group('A','2026-06-01',0,null,null,null)]},
  {name:'mean-rounding',input:csv([['C','x','2026-07-01T00:00:00','0','ok'],['C','y','2026-07-01T00:01:00','1','ok'],['C','z','2026-07-01T00:02:00','1','ok']]),expected:[group('C','2026-07-01',3,0.667,0,1)]},
  {name:'balanced-200-rows',input:csv(stress),expected:stressExpected},
  {name:'unique-row-reversal-and-output-sort',input:csv(stress.slice().reverse()),expected:stressExpected},
 ];
}
export const primaryCsv=csv(primaryRows);
