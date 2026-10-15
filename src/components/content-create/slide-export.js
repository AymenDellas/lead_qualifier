// Font size adapts to the complete copy; never silently discard lines.
export async function downloadSlide(slide,index,count) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 1080; canvas.height = 1350;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser could not prepare this slide.');
  const tokens = getComputedStyle(document.documentElement);
  const color = key=>tokens.getPropertyValue(key).trim();
  context.fillStyle=color('--text');context.fillRect(0,0,1080,1350);
  context.fillStyle=color('--surface-1');context.font='24px Arial';
  context.fillText('COMPEL / FUNNEL NOTES',80,100);
  context.textAlign='right';context.fillText(`${index+1} / ${count}`,1000,100);context.textAlign='left';
  context.fillStyle=color('--signal-line');context.font='26px Arial';context.fillText(String(slide.role||'').toUpperCase().slice(0,45),80,275);
  const wrap = size=>{
    context.font=`700 ${size}px Arial`;
    const rows=[];
    for(const paragraph of String(slide.copy||'').split('\n')) {
      let row='';
      for(const word of paragraph.split(/\s+/).filter(Boolean)) {
        if(context.measureText(word).width>910) {
          if(row){rows.push(row);row='';}
          for(const character of word){if(context.measureText(row+character).width>910){rows.push(row);row='';}row+=character;}
        } else if(context.measureText((row?row+' ':'')+word).width>910){rows.push(row);row=word;}
        else row+=(row?' ':'')+word;
      }
      rows.push(row);
    }
    return rows;
  };
  let size=76, rows=wrap(size);
  while(size>20&&rows.length*size*1.25>830){size-=2;rows=wrap(size);}
  if(rows.length*size*1.25>830)throw new Error('This slide has too much copy to export legibly. Shorten it or split it into two slides.');
  context.fillStyle=color('--surface-1');rows.forEach((row,i)=>context.fillText(row,80,390+i*size*1.25));
  context.font='22px Arial';context.fillText(index===0?'Swipe to explore →':'One clear idea. One useful next step.',80,1270);
  const blob = await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw new Error('The slide export failed. Please try again.');
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.download=`compel-slide-${String(index+1).padStart(2,'0')}.png`;link.href=url;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
