import test from 'node:test';
import assert from 'node:assert/strict';
import { proofPreview, reviewSummary, sourceExcerpt } from '../../src/lib/onboarding-review';

test('a large proof archive exposes only three attributed, bounded excerpts and retains the originals', () => {
    const quote = 'I spent years wondering what to do next. '.repeat(40) + 'Coaching helped me choose a clear next step.';
    const source = Array.from({ length: 8 }, (_, i) => `Quote:\n${quote}\nAttribution: Client ${i + 1}\nSource: https://example.com/results\nCategory: Client experience`).join('\n\n');
    const preview = proofPreview(source);
    assert.equal(preview.total, 8); assert.equal(preview.items.length, 3);
    assert.equal(preview.items[0].attribution, 'Client 1');
    assert.equal(preview.items[0].quote, quote);
    for (const item of preview.items) {
        assert.ok(item.excerpt.split(/\s+/).length <= 44);
        assert.ok(item.quote.includes(item.excerpt.replace(/^… | …$/g, '')));
    }
    assert.ok(reviewSummary(source, 'proof').length < 2000);
});

test('story previews select relevant complete facts without changing the source', () => {
    const original = 'Welcome to a world of possibility. I have twenty years of coaching experience. I trained as a career coach. Book your session today.';
    assert.equal(reviewSummary(original, 'coachBio'), 'I have twenty years of coaching experience. I trained as a career coach.');
    assert.equal(sourceExcerpt('Short factual statement.'), 'Short factual statement.');
    assert.equal(reviewSummary('', 'coachBio'), '');
});
