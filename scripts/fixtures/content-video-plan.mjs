export function sampleVideoPlan(body = 'A complete useful post body.') {
  return {
    recordingSetup:'Record your screen and microphone. Zoom to one frame at a time. Keep an optional face bubble in the lower corner, clear of the board.',
    boardLayout:'Create three landscape frames in a row, left to right. Use large text, neutral headings and yellow sticky notes. Prebuild the objects before recording.',
    frames:[
      {title:'The decision',seconds:10,script:'Hook',layout:'Centre the heading above the sticky note.',items:[{kind:'Heading',text:'Booking is a decision',placement:'Top centre'},{kind:'Sticky note',text:'What happens on this call?',placement:'Centre'}],action:'Start zoomed into frame 1. Point to the question as you say the hook.'},
      {title:'Make it clear',seconds:50,script:body,layout:'Place the two notes side by side. Connect left to right with an arrow labelled “Explain the next step”.',items:[{kind:'Heading',text:'Illustrative example',placement:'Top centre'},{kind:'Sticky note',text:'Before: Book now',placement:'Left'},{kind:'Sticky note',text:'After: See what the call covers',placement:'Right'}],action:'Pan to frame 2. Point first to the vague wording, then follow the arrow to the clearer next step. Pause.'},
      {title:'Your next step',seconds:10,script:'A natural closing question?',layout:'Place one large note in the centre, with space around it.',items:[{kind:'Sticky note',text:'Is the next step clear?',placement:'Centre'}],action:'Move to frame 3 and hold on the question as you close. Leave a beat before stopping the recording.'},
    ],
  };
}
