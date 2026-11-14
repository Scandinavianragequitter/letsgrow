// All user/friend-facing copy in one place. Swap for LLM-written text later if you like.

const pick = <T,>(arr: T[], i: number) => arr[Math.abs(i) % arr.length];

export const msg = {
  userConnected: (name: string, title: string) =>
    `Hey ${name}, you're connected. I'll use this thread for "${title}": reminders when I need you, and a heads-up if something needs attention. React ❤️ to a reminder (or reply "done") when you've done it.`,

  userStarted: (title: string, days: number) =>
    `"${title}" starts today. ${days} days. Send your friend the link from the app so someone has your back.`,

  userAck: "Logged. Nice work.",
  userAutoTracked: "I'm tracking this one automatically, nothing to report. Keep going.",
  userHowTo: "Got it. To log a rep, just react ❤️ to my reminder (or reply \"done\").",

  friendWelcome: (friend: string, user: string, title: string, days: number) =>
    `Hi ${friend}! ${user} asked you to be their accountability buddy for "${title}" over the next ${days} days. I'm ${user}'s Let'sGrow agent. I won't spam you: I'll only text if ${user} slips. When I do, a short message of support from you makes a real difference. You can reply here any time and I'll pass it on.`,

  friendNudge: (friend: string, user: string, title: string, misses: number, i: number) => {
    const days = misses > 1 ? `${misses} days in a row` : "today";
    return pick([
      `Hey ${friend}, ${user} missed their habit (${title}) ${days}. Could you send them a quick word of support? Just reply here and I'll pass it on.`,
      `${friend}, small ask: ${user} slipped on "${title}" ${days}. A friendly nudge from you would help. Reply and I'll forward it.`,
      `Quick one, ${friend}: ${user} is behind on "${title}" (${days}). Cheer them on? Reply here and I'll deliver it.`,
    ], i);
  },

  friendThanks: (user: string) => `Thank you! I've passed that on to ${user}.`,
  relayToUser: (friend: string, text: string) => `${friend} says: "${text}"`,
  relayReactionToUser: (friend: string, emoji: string) => `${friend} sent you a ${emoji}.`,

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
