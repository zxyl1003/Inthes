import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseQuote, readingQuotes } from '../src/quotes.ts';

test('startup quote selection covers the collection and avoids repeating the previous quote',()=>{
  for(let previous=0;previous<readingQuotes.length;previous++){
    const selected=new Set<number>();
    for(let i=0;i<readingQuotes.length-1;i++)selected.add(chooseQuote(previous,()=> (i+.5)/(readingQuotes.length-1)));
    assert.equal(selected.size,readingQuotes.length-1);
    assert.ok(!selected.has(previous));
    assert.ok([...selected].every(i=>!!readingQuotes[i]));
  }
  assert.equal(chooseQuote(undefined,()=>0),0);
  assert.equal(chooseQuote(undefined,()=>.999999),readingQuotes.length-1);
});

test('every displayed quote has a distinct text and a source that readers can open',()=>{
  assert.ok(readingQuotes.length>=30);
  assert.equal(new Set(readingQuotes.map(q=>q.text)).size,readingQuotes.length);
  for(const quote of readingQuotes){assert.ok(quote.author&&quote.work);assert.equal(new URL(quote.url).protocol,'https:');}
});
