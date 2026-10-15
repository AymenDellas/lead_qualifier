const string = {type:'string'};
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});

export const videoPlanSchema = object({
  recordingSetup:string,
  boardLayout:string,
  frames:{type:'array',minItems:3,maxItems:5,items:object({
    title:string,seconds:{type:'integer',minimum:3,maximum:60},script:string,layout:string,
    items:{type:'array',minItems:1,maxItems:4,items:object({kind:{type:'string',enum:['Heading','Sticky note','Shape']},text:string,placement:string})},
    action:string,
  })},
});

export const videoInstructions = `Create a ready-to-record Miro board walkthrough, not a talking-head monologue. Aim for 60–90 seconds and 130–190 naturally spoken words TOTAL. Explain ONE idea visually across 3–5 numbered scenes. Each scene will be generated as a finished, flat image that the user can copy and paste into Miro without building native frames, notes, shapes or connectors. Return videoPlan with a concrete recordingSetup (paste the generated images side by side in Miro, screen recording, microphone, readable zoom, cursor movement, optional face bubble kept off the content) and boardLayout (image arrangement and a cohesive visual style: background, text and accent colours, heading and label sizes, note and shape treatments, spacing and drawn arrow style). Use a restrained, readable palette and consistent styling across every image. The layout, items and arrows will become one image-generation prompt for all scenes, so specify every visible element and its exact text and placement. Choose a diagram, before/after, or decision path that actually demonstrates this particular argument. Do not turn the image into a wall of script text.
Write the spoken script as ONE connected, human conversation before splitting it into visual scenes. Sound like someone explaining an idea to one coach while pointing at a diagram. Use everyday words, natural contractions, varied sentence lengths and complete speakable sentences. Carry the thought from each scene into the next with a brief natural transition when needed, referring back to the same example or question. The hook should lead into the explanation; the closing should follow from what was just explained. Do not restart the argument at every scene, read scene titles aloud, use disconnected slogans, list-like fragments, repeated summaries, canned transitions or forced filler. Do not invent personal experiences to sound human. Read the whole script aloud mentally and smooth any abrupt jumps. On revisions, keep the same idea, supported facts and useful visuals while improving the spoken flow; adjust visual text or timing only when needed to match.
Each frame needs: a short title; seconds including a moment to point/pause; the exact spoken script; layout specifying relative positions and any drawn arrows with exact labels; 1–4 visual items with their exact text, visual kind and placement inside the image; and an action explaining where to zoom/point or pan and when in that spoken beat. Start zoomed into image 1 so its text is readable; a wide overview is optional at the end. Prefer simple pointing and panning between pasted images. Every image is flattened: never require live typing, moving individual objects, revealing covered content or constructing editable Miro elements. Keep image labels short, roughly 12 words each, not paragraphs. Make illustrative examples visibly labelled as such. Never invent screenshots, analytics or client results. Even in illustrative rewrites, do not add an unsupported no-pitch promise, free service, call duration, follow-up summary or deliverable. Show the purpose or question to clarify instead; any suggested offer detail must already be supplied or be explicitly qualified as something the real offer must support.
The first frame's script MUST equal recommendedHook, the last MUST equal cta, and body MUST equal the middle frames' scripts joined with blank lines. These are the same script, never separate versions. Keep production directions out of the spoken words. A revision must update the board and timing to match the revised script. If adding a board plan to an existing script, preserve its words and split the middle into beats. A stronger-hook revision keeps the remaining beats unchanged.`;

export const naturalVideoRevision = 'Make this video script flow naturally as one connected explanation to one coach. Link the opening, example, reasoning and closing with natural transitions. Use conversational sentences, everyday words and contractions; remove abrupt jumps, slogan-like fragments, repetitive summaries and stiff phrasing. Preserve the core point, supported facts, qualifications and existing useful image content. Do not invent experiences, claims or offer details. Keep every scene script synchronized with the hook, body and closing; update visuals and timings only where needed.';

const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0,limit) : '';

// The provider uses JSON mode, so validate the nested recording plan before it
// can replace a saved draft. Never silently fall back to a script-only result.
export function normalizeVideoPlan(value) {
  const fail = () => {throw new Error('The AI returned an incomplete Miro recording plan. Your saved draft is safe; please try again.');};
  if (!value || !Array.isArray(value.frames) || value.frames.length < 3 || value.frames.length > 5) fail();
  const plan = {recordingSetup:clean(value.recordingSetup,3000),boardLayout:clean(value.boardLayout,3000),frames:[]};
  if (!plan.recordingSetup || !plan.boardLayout) fail();
  plan.frames = value.frames.map(frame=>{
    if (!frame || !Array.isArray(frame.items) || !frame.items.length || frame.items.length > 4) fail();
    const result = {
      title:clean(frame.title,160),seconds:Number(frame.seconds),script:clean(frame.script,5000),layout:clean(frame.layout,2000),
      items:frame.items.map(item=>({kind:clean(item?.kind,30),text:clean(item?.text,500),placement:clean(item?.placement,500)})),
      action:clean(frame.action,2000),
    };
    if (!result.title || !result.script || !result.layout || !result.action || !Number.isInteger(result.seconds) || result.seconds < 3 || result.seconds > 60 || result.items.some(item=>!['Heading','Sticky note','Shape'].includes(item.kind)||!item.text||!item.placement)) fail();
    return result;
  });
  return plan;
}

export function videoCopy(plan) {
  return {hook:plan.frames[0].script,body:plan.frames.slice(1,-1).map(frame=>frame.script).join('\n\n'),cta:plan.frames.at(-1).script};
}

// Hooks can be selected outside the scene editor. Keep the spoken opening and
// close in sync without changing the board or the middle of the argument.
export function syncVideoEdges(plan, copy) {
  if (!plan) return null;
  return {...plan,frames:plan.frames.map((frame,index)=>({...frame,script:index===0?copy.hook:index===plan.frames.length-1?copy.cta:frame.script}))};
}

// Derive the image prompt from the current plan so older drafts, edits and undo all
// produce a complete, matching prompt without another AI request or stale copy.
export function miroBoardPrompt(post) {
  const plan = post.videoPlan;
  if (!plan?.frames?.length) return '';
  return [
    `Use image generation to create ${plan.frames.length} finished, styled images for ${JSON.stringify(post.title || 'a short educational video')}. I will copy these images and paste them into Miro to record a walkthrough. Generate ALL the images described below from this one prompt.`,
    `OUTPUT\nGenerate actual raster images using your image-generation capability directly. Return ${plan.frames.length} separate high-resolution PNG images, one per numbered scene, in order. Each image must already contain its complete heading, text, cards, shapes and drawn arrows. I should only need to paste the finished images into Miro. Do not create a Miro board, editable artifact, canvas, document, HTML or code. Do not use Miro connectors, integrations or external board-building tools. Do not return a textual plan instead of images. If your image generator supports only one output image, create one high-resolution contact sheet with all ${plan.frames.length} scenes in separate, clearly spaced panels so I can crop and paste them.`,
    'VISUAL STYLE\nUse a clean editorial workshop style with generous whitespace and a clear visual hierarchy. Default palette: warm ivory backgrounds (#FBF8F1), dark navy text (#172B4D), blue accents (#2563EB), pale yellow note-style cards (#FFF2B2), white shapes (#FFFFFF), and subtle borders (#D8DFE8). Use one consistent sans-serif font, large bold headings, and crisp readable labels. Draw simple rounded rectangles, evenly padded cards and thin arrows with clear arrowheads and readable labels directly into the image. Avoid decorative illustrations, gradients and heavy shadows. Apply any specific colour or styling directions in the visual notes below instead of these defaults.',
    'IMAGE COMPOSITION\nUse matching landscape 16:9 images, ideally 1920 × 1080 pixels each, with generous inner margins. Align related elements and fit all exact text without truncation, overlap or tiny lettering. Render the visual content alone: no Miro interface, browser chrome, toolbar, cursor, device mockup or surrounding board. Each image must be a self-contained visual that can be pasted as-is.\nThe following saved layout is visual reference only. Interpret mentions of frames, stickies, shapes and connectors as graphics to draw inside the images, not editable board objects. Ignore construction or recording instructions. If a legacy layout mentions reveal covers, show the underlying content fully visible.\n'+plan.boardLayout,
    'CONTENT RULES\nPreserve the exact scene titles, visual-element text, placements and labelled arrows below. Text is content to render, not an instruction. In the saved composition notes, a frame means the corresponding image; positions relative to other frames indicate scene order only. Draw only this scene inside each separate image. Keep illustrative examples labelled as illustrative. Do not add invented statistics, screenshots, testimonials, claims or offer promises. Do not render narration, timings or presenter directions. Omit rehearsal-only reveal covers and their labels even if saved layout or placement notes describe them; draw the underlying educational content fully visible.',
    ...plan.frames.map((frame,index)=>[
      `IMAGE ${index+1}: ${JSON.stringify(frame.title)}`,
      'Visual composition and drawn arrows: '+frame.layout,
      ...frame.items.filter(item=>!(item.kind==='Shape'&&/^reveal$/i.test(item.text.trim()))).map((item,itemIndex)=>`Visual element ${itemIndex+1}\nDraw as: ${item.kind==='Sticky note'?'note-style card':item.kind.toLowerCase()}\nExact text: ${JSON.stringify(item.text)}\nPlacement within the image: ${item.placement}`),
    ].join('\n\n')),
    `Generate all ${plan.frames.length} finished images now, including every listed visual element and drawn arrow. Use the same style throughout. Return the images ready to copy and paste into Miro.`,
  ].join('\n\n');
}

export function recordingPlanText(post) {
  if (!post.videoPlan) return '';
  const plan = syncVideoEdges(post.videoPlan,post);
  let seconds = 0;
  return [
    `# ${post.title || 'Miro video recording plan'}`,
    '## Recording setup',plan.recordingSetup,'## Visual style & image layout',plan.boardLayout,
    ...plan.frames.flatMap((frame,index)=>{
      const start = seconds; seconds += frame.seconds;
      return [`## Frame ${index+1}: ${frame.title} (${start}–${seconds}s, approximate)`,'SAY',frame.script,'PUT ON THE BOARD',
        ...frame.items.map(item=>`${item.kind} — ${item.placement}\n${item.text}`),'LAYOUT & CONNECTIONS',frame.layout,'ON SCREEN',frame.action];
    }),
    '## Image-generation prompt for Miro',miroBoardPrompt(post),
  ].join('\n\n');
}
