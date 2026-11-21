export const defaultGlossary = [
  { en: 'API', zh: 'API（应用程序接口）' }, { en: 'timeout', zh: '超时' }, { en: 'retry mechanism', zh: '重试机制' },
  { en: 'idempotency', zh: '幂等性' }, { en: 'deployment', zh: '部署' }, { en: 'rollback', zh: '回滚' },
  { en: 'rate limiting', zh: '限流' }, { en: 'latency', zh: '延迟' }, { en: 'staging', zh: '预发布环境' },
  { en: 'CI/CD', zh: '持续集成与持续交付' }, { en: 'Kubernetes', zh: 'Kubernetes' }, { en: 'pull request', zh: '代码合并请求' },
  { en: 'exponential backoff', zh: '指数退避' },
];

export function createMeeting() {
  return { id: crypto.randomUUID(), title: '新的技术会议', createdAt: new Date().toISOString(), entries: [], gaps: [], summary: null, summaryCount: 0, endedAt: null, demo: false };
}

export function demoMeeting() {
  const meeting = createMeeting();
  meeting.title = 'API 集成与发布方案评审'; meeting.demo = true;
  const lines = [
    ['remote', 'Let’s review the API timeout and retry policy before the next release.', '我们在下次发布前，先评审 API 的超时设置和重试策略。', 'Let’s review the API timeout and retry policy before the next release.'],
    ['me', '目前这个 API 的 timeout 是 3 秒，高峰期会出现 intermittent failures。', '目前这个 API 的超时时间是 3 秒，高峰期会出现间歇性故障。', 'The timeout for this API is currently 3 seconds. We are seeing intermittent failures during peak hours.'],
    ['remote', 'Could we increase it to 10 seconds and add exponential backoff? We also need to make sure POST requests are idempotent.', '我们能否将超时时间增加到 10 秒，并加入指数退避重试？还需要确保 POST 请求具备幂等性。', 'Could we increase it to 10 seconds and add exponential backoff? We also need to make sure POST requests are idempotent.'],
    ['me', '可以，就按这个方案做。我们会加 idempotency key，最多 retry 3 次。', '可以，就按这个方案做。我们会添加幂等键，最多重试 3 次。', 'Agreed, let’s go with that approach. We will add an idempotency key and retry up to 3 times.'],
    ['remote', 'Great. Alex will update the API documentation by Friday. How will we handle the rollback if the error rate goes up?', '好的。Alex 会在周五前更新 API 文档。如果错误率上升，我们将如何回滚？', 'Great. Alex will update the API documentation by Friday. How will we handle the rollback if the error rate goes up?'],
    ['me', '回滚的 threshold 还需要和运维确认。我们先在 staging 跑一轮 load test。', '回滚阈值还需要和运维确认。我们先在预发布环境进行一轮负载测试。', 'We still need to confirm the rollback threshold with the operations team. Let’s run a load test in staging first.'],
  ];
  meeting.createdAt = new Date(Date.now() - lines.length * 42000).toISOString();
  meeting.endedAt = new Date().toISOString();
  meeting.entries = lines.map(([source, original, chinese, english], i) => ({ id: `demo-${i + 1}`, source, original, chinese, english, uncertain: false, status: 'done', time: new Date(Date.now() - (lines.length - i) * 42000).toISOString() }));
  meeting.summary = {
    overview: '评审 API 超时和重试方案，确认采用 10 秒超时、指数退避和幂等键。发布前需完成文档更新与预发布负载测试。',
    decisions: [{ text: '采用 10 秒超时、指数退避与幂等键，最多重试 3 次。', sourceIds: ['demo-3', 'demo-4'] }],
    actions: [{ task: '更新 API 文档', owner: 'Alex', due: '周五前（原话）', sourceIds: ['demo-5'] }, { task: '在预发布环境执行负载测试', owner: '待确认', due: '待确认', sourceIds: ['demo-6'] }],
    questions: [{ text: '回滚触发阈值仍需与运维确认。', sourceIds: ['demo-5', 'demo-6'] }],
  };
  meeting.summaryCount = meeting.entries.length;
  return meeting;
}

export function recoverMeeting(meeting) {
  for (const entry of meeting.entries || []) {
    if (['queued', 'recognizing', 'translating', 'live'].includes(entry.status)) {
      entry.status = 'error'; entry.error = '上次处理因页面关闭而中断。文字可重试；未保存的音频需重新录入。';
    }
  }
  return meeting;
}

export function exportMarkdown(meeting) {
  const date = new Date(meeting.createdAt).toLocaleString('zh-CN', { timeZoneName: 'short' });
  const lines = [`# ${meeting.title}`, '', `开始时间：${date}`, `来源：${meeting.demo ? '预置演示数据（非真实会议）' : '会议输入记录'}`, ''];
  const s = meeting.summary;
  if (s) {
    lines.push('## 会议纪要', '', s.overview, '');
    if (meeting.summaryCount !== meeting.entries.filter(e => e.status === 'done').length) lines.push('> 此纪要尚未包含最新发言。', '');
    const refs = item => `（原文：${item.sourceIds.join('、')}）`;
    lines.push('### 已确定事项', '', ...s.decisions.map(i => `- ${i.text} ${refs(i)}`), '', '### 待办事项', '', ...s.actions.map(i => `- ${i.task}；负责人：${i.owner}；期限：${i.due} ${refs(i)}`), '', '### 未解决问题', '', ...s.questions.map(i => `- ${i.text} ${refs(i)}`), '');
  }
  lines.push('## 完整对话', '');
  for (const e of meeting.entries) {
    lines.push(`### ${new Date(e.time).toLocaleTimeString('zh-CN')} · ${e.source === 'me' ? '我' : `对方${e.speakerLabel ? ` · ${e.speakerLabel}` : ''}`} [${e.id}]`, '', `原文：${e.original || '音频未识别成功'}`, '', `中文：${e.chinese || '未生成'}`, '', `英文：${e.english || '未生成'}`, '');
    if (e.input === 'realtime' && e.status !== 'done') lines.push('> 实时同传暂定结果，尚未完整确认。', '');
    if (e.spokenText) lines.push(`播报用编辑稿：${e.spokenText}`, '');
    if (e.error) lines.push(`处理状态：${e.error}`, '');
  }
  if (meeting.gaps?.length) lines.push('## 采集中断记录', '', ...meeting.gaps.map(g => `- ${new Date(g.start).toLocaleTimeString('zh-CN')} 至 ${new Date(g.end).toLocaleTimeString('zh-CN')}：${g.reason}`), '');
  return lines.join('\n');
}
