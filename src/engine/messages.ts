// Fallback wording for proactive messages. The agent writes these normally (agent.write); these
// are only sent when the model is unavailable, so a rate limit never means someone isn't told.

const pick = <T,>(arr: T[], i: number) => arr[Math.abs(i) % arr.length];

export const msg = {
  userStarted: (title: string, days: number) =>
    `"${title}" starts today. ${days} days. Send your friend the link from the app so someone has your back.`,

  friendNudge: (friend: string, user: string, title: string, misses: number, i: number) => {
    const days = misses > 1 ? `${misses} days in a row` : "today";
    return pick([
      `Hey ${friend}, ${user} missed their habit (${title}) ${days}. Could you send them a quick word of support? Just reply here and I'll pass it on.`,
      `${friend}, small ask: ${user} slipped on "${title}" ${days}. A friendly nudge from you would help. Reply and I'll forward it.`,
      `Quick one, ${friend}: ${user} is behind on "${title}" (${days}). Cheer them on? Reply here and I'll deliver it.`,
    ], i);
  },

  noFriendYet: (url: string) =>
    `I'd normally ask a friend to back you up, but nobody has joined yet. Send them your link: ${url}`,

  userCongrats: (name: string, title: string, days: number, done: number, counted: number, longest: number, friendLine: string) =>
    `${days} days. You did it, ${name}! "${title}": ${done} of ${counted} days on target, longest streak ${longest}. ${friendLine} That's real personal growth. Proud of you.`,

  friendCongrats: (friend: string, user: string, title: string, days: number, nudges: number, replies: number) => {
    const help = nudges === 0
      ? `${user} never needed a nudge, but knowing you were there helped.`
      : `I asked you to step in ${nudges} time${nudges === 1 ? "" : "s"} and you replied ${replies} time${replies === 1 ? "" : "s"}.`;
    return `${friend}, ${user} just finished ${days} days of "${title}"! ${help} Part of that growth is yours. Thank you.`;
  },
};
