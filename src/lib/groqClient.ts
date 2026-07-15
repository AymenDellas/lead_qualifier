import Groq from 'groq-sdk';

const SYSTEM_PROMPT = `You are an expert at writing personalized cold email opening lines for a funnel agency targeting coaches.

Your job is to read a coach's website and write ONE opening line that will be used as the first sentence of a cold email.

RULES:
- The line must reference something SPECIFIC from their website: their niche, their method, their audience, their results, their story, or their positioning.
- It must feel like the sender actually read their site, not generic flattery.
- It must be conversational and flow naturally as a standalone sentence.
- Minimum 10 words. Max 20 words.
- No em dashes. No quotes. No filler like "I noticed" or "I came across your site".
- ALWAYS start with "Your" — never start with the person's name, company name, or any third-party reference.
- Capitalize normally as a real sentence. Proper nouns capitalized.
- If the website text looks like an error page (e.g. 502 Bad Gateway, 403 Forbidden, Site Inaccessible, Domain Unconnected, Parked Domain), DO NOT generate a hook. Return an empty string "".
- Output STRICT JSON only.

SCHEMA:
{"hook": string}

GOOD EXAMPLES:
{"hook": "Your three decades of expertise in exit strategies suggest you appreciate systems built on actual performance."}
{"hook": "Your blend of trauma-informed coaching and corporate pricing expertise creates a powerful differentiator for executive women."}
{"hook": "Building a practice around helping burned-out executives reclaim clarity puts you in a category most coaches never reach."}

BAD EXAMPLES:
{"hook": "I noticed you have a coaching business."} — too generic
{"hook": "Your website is impressive."} — flattery, not specific
{"hook": "As a life coach, you help people."} — no differentiation
{"hook": "Alex Wisch's 360-degree approach..."} — starts with name, not "Your"
`;

export async function generateHook(websiteText: string, apiKeyIndex: number = 0): Promise<any> {
    const keys = [
        process.env.GROQ_API_KEY,
        process.env.GROQ_API_KEY_2,
        process.env.GROQ_API_KEY_3,
        process.env.GROQ_API_KEY_4
    ].filter(Boolean) as string[];

    if (keys.length === 0) {
        throw new Error("No Groq API keys configured in environment.");
    }

    const key = keys[apiKeyIndex % keys.length];
    const groq = new Groq({ apiKey: key });

    try {
        const response = await groq.chat.completions.create({
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: `Website Text:\n${websiteText.substring(0, 8000)}` }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.2,
            response_format: { type: "json_object" }
        });

        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error("No content returned from Groq");

        return JSON.parse(content);
    } catch (e: any) {
        console.error("Groq Generation Error:", e.message);
        throw e;
    }
}
