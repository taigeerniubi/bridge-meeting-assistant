import test from 'node:test';
import assert from 'node:assert/strict';
import { demoMeeting, recoverMeeting, exportMarkdown } from '../public/store.mjs';
test('demo export explicitly identifies sample data and includes source evidence', () => {
  const meeting = demoMeeting(); const markdown = exportMarkdown(meeting);
  assert.match(markdown, /预置演示数据/); assert.match(markdown, /demo-3/); assert.match(markdown, /幂等/); assert.match(markdown, /待确认/);
});
test('reload recovers interrupted work as actionable failure rather than infinite spinner', () => {
  const meeting = demoMeeting(); meeting.entries[0].status = 'recognizing';
  recoverMeeting(meeting); assert.equal(meeting.entries[0].status, 'error'); assert.match(meeting.entries[0].error, /中断/);
});
test('export distinguishes edited spoken text, stale summaries, and capture gaps', () => {
  const meeting = demoMeeting(); meeting.entries[1].spokenText = 'Edited text.'; meeting.summaryCount = 0;
  meeting.gaps.push({ start: meeting.createdAt, end: meeting.createdAt, reason: '播报期间暂停' });
  const result = exportMarkdown(meeting); assert.match(result, /播报用编辑稿/); assert.match(result, /尚未包含最新发言/); assert.match(result, /采集中断记录/);
});
