// Host-owned, fixed expectations. No production audit algorithm is reused here.
// Keep this module outside the synthetic project and Worker candidate.
export const rooms = [
  {id:'R1',capacity:8,equipment:['projector'],bufferMinutes:10},
  {id:'R2',capacity:4,equipment:['whiteboard'],bufferMinutes:0},
];
const time = (clock,day='2026-10-26') => `${day}T${clock}:00+08:00`;
const booking = (id,room,start,end,extra={}) => ({id,revision:1,room,start:time(start),end:time(end),attendees:4,equipment:[],cancelled:false,...extra});
const suggestion = (id,room,start,end,day='2026-10-26') => ({id,room,start:time(start,day),end:time(end,day)});
const expected = (active=[],cancelled=[],invalid=[],conflicts=[],suggestions=[]) => ({active,cancelled,invalid,conflicts,suggestions});
export const primaryBookings = [
  booking('A','R1','09:00','10:00',{attendees:6}),
  booking('A','R1','09:00','10:00',{revision:2,attendees:9}),
  booking('B','R1','10:00','11:00'),
  booking('C','R1','11:00','11:30'),
  booking('D','R1','11:40','12:00'),
  booking('E','R2','10:00','11:00'),
  booking('F','R2','11:00','12:00'),
  booking('G','R2','10:30','11:00',{equipment:['projector']}),
  booking('H','R1','09:00','10:00'),
  booking('H','R1','09:00','10:00',{revision:2,cancelled:true}),
  booking('I','R1','13:00','14:00',{revision:3}),
  booking('I','R1','14:00','15:00',{revision:3}),
  booking('J','R1','15:10','15:40',{attendees:2}),
];
export function bookingCases() {
  return [
    {name:'primary-A-J-independent-suggestions',rooms,bookings:primaryBookings,expected:expected(
      ['B','C','D','E','F','I','J'],['H'],[{id:'A',reason:'capacity'},{id:'G',reason:'equipment'}],[['B','C']],
      [suggestion('B','R1','15:50','16:50'),suggestion('C','R1','15:50','16:20')])},
    {name:'complete-containment',rooms,bookings:[booking('L','R2','09:00','12:00'),booking('M','R2','10:00','11:00')],expected:expected(['L','M'],[],[],[['L','M']],[suggestion('L','R2','12:00','15:00'),suggestion('M','R2','12:00','13:00')])},
    {name:'zero-and-reversed-intervals',rooms,bookings:[booking('Z','R1','10:00','10:00'),booking('R','R1','11:00','10:00')],expected:expected([],[],[{id:'R',reason:'interval'},{id:'Z',reason:'interval'}])},
    {name:'unknown-room',rooms,bookings:[booking('X','R404','09:00','10:00')],expected:expected([],[],[{id:'X',reason:'room'}])},
    {name:'cross-date-does-not-share-clock-conflict',rooms,bookings:[booking('P','R1','09:00','10:00'),booking('Q','R1','09:00','10:00',{start:time('09:00','2026-10-27'),end:time('10:00','2026-10-27')})],expected:expected(['P','Q'])},
    {name:'same-revision-last-file-record',rooms,bookings:[booking('T','R2','09:00','10:00',{revision:3}),booking('T','R2','11:00','12:00',{revision:3}),booking('U','R2','09:30','09:45')],expected:expected(['T','U'])},
    {name:'invalid-high-revision-no-fallback',rooms,bookings:[booking('V','R1','09:00','10:00'),booking('V','R1','09:00','10:00',{revision:2,attendees:9}),booking('W','R1','09:30','10:00')],expected:expected(['W'],[],[{id:'V',reason:'capacity'}])},
    {name:'cancellation-wins-before-validation',rooms,bookings:[booking('K','R1','09:00','10:00'),booking('K','missing','11:00','10:00',{revision:2,attendees:0,cancelled:true}),booking('N','R1','09:30','10:00')],expected:expected(['N'],['K'])},
    {name:'half-open-buffer-endpoint-and-sort',rooms,bookings:[booking('C','R1','10:40','11:00'),booking('B','R1','10:10','10:30'),booking('A','R1','09:00','10:00')],expected:expected(['A','B','C'])},
    {name:'five-minute-ceiling-not-joint-scheduling',rooms,bookings:[booking('B','R2','10:01','10:16'),booking('A','R2','10:00','10:13')],expected:expected(['A','B'],[],[],[['A','B']],[suggestion('A','R2','10:20','10:33'),suggestion('B','R2','10:20','10:35')])},
    {name:'attendees-and-equipment-validation',rooms,bookings:[booking('D','R1','09:00','10:00',{attendees:1.5}),booking('C','R1','09:00','10:00',{attendees:0}),booking('B','R1','09:00','10:00',{equipment:['whiteboard']}),booking('A','R1','09:00','10:00',{equipment:['projector'],attendees:8})],expected:expected(['A'],[],[{id:'B',reason:'equipment'},{id:'C',reason:'attendees'},{id:'D',reason:'attendees'}])},
    {name:'cross-midnight-absolute-overlap',rooms,bookings:[booking('A','R2','23:30','23:50',{end:time('00:10','2026-10-27')}),booking('B','R2','00:05','00:20',{start:time('00:05','2026-10-27'),end:time('00:20','2026-10-27')})],expected:expected(['A','B'],[],[],[['A','B']],[suggestion('A','R2','00:10','00:50','2026-10-27'),suggestion('B','R2','00:20','00:35','2026-10-27')])},
  ];
}
