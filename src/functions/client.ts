import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "creative-partner-os",
  name: "Creative Partner Operations System",
  eventKey: process.env.INNGEST_EVENT_KEY
});
