import { Photon, ApiError } from "@photon-ai/api";

/** Puts a person on Photon's shared iMessage line so they can text the agent (and be texted back). */
export interface LineAssigner {
  assign(handle: string, firstName: string): Promise<{ number: string; alreadyAssigned: boolean }>;
}

export class ConsoleAssigner implements LineAssigner {
  constructor(private number: string) {}
  async assign() { return { number: this.number, alreadyAssigned: false }; }
}

export class PhotonAssigner implements LineAssigner {
  private photon: Photon;
  constructor(apiKey: string, private projectId: string, private fallbackNumber: string) {
    this.photon = new Photon({ headers: { Authorization: `Bearer ${apiKey}` } });
  }
  async assign(handle: string, firstName: string) {
    try {
      const a = await this.photon.projects.platforms.imessage.assignments.create({
        path: { id: this.projectId },
        headers: { idempotencyKey: `letsgrow-assign-${handle}` },
        body: { handle, firstName },
      });
      return { number: a.assignedPhoneNumber, alreadyAssigned: false };
    } catch (err) {
      // 409 ASSIGNMENT_EXISTS: they are already on a line; look it up.
      if (err instanceof ApiError && err.status === 409) {
        try {
          const list = await this.photon.projects.platforms.imessage.assignments.list({ path: { id: this.projectId } });
          const hit = list.assignments.find((x) => x.handle === handle);
          if (hit) return { number: hit.assignedPhoneNumber, alreadyAssigned: true };
        } catch { /* fall through */ }
        return { number: this.fallbackNumber, alreadyAssigned: true };
      }
      throw err;
    }
  }
}
