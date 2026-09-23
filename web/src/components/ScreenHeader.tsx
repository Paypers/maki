/**
 * The header every main screen shares, with the save status built in.
 *
 * "Is what I typed saved?" was a question the operator had to ask out loud
 * after a morning's entries went missing. So it is answered on every main
 * screen, in the same corner, in words: saved on the phone, and how much is
 * still waiting to reach the cloud. Green means saved and nothing else.
 */

import { createContext, useContext } from "react";
import { Icon } from "./Icon";
import { syncStatus } from "../lib/cloud";

export interface SaveStatus { pending: number; online: boolean }

export const SaveStatusContext = createContext<SaveStatus>({ pending: 0, online: true });

export function SaveChip() {
  const { pending, online } = useContext(SaveStatusContext);
  const cloud = syncStatus(pending);
  // Saved on the phone is always true once a confirm returns -- a failed
  // write says so on its own screen. The second half is the cloud copy, and
  // it only claims one when there is one.
  const second = !cloud.live ? "cloud off" : !online && pending ? "offline" : pending ? `${pending} to sync` : "";
  return (
    <span className="savechip" role="status" title={`Saved on this phone. Cloud: ${cloud.label}.`}>
      <Icon name="check" size={13} className="ok" />
      <strong>Saved on phone</strong>
      {second && <span>· {second}</span>}
    </span>
  );
}

export function ScreenHeader({ eyebrow, title, onBack }: {
  eyebrow: string;
  title: string;
  /** Only sub-screens get one; the five main screens are on the tab bar. */
  onBack?: () => void;
}) {
  return (
    <header className="bar main">
      <h1>
        {title}
        <span className="sub">{eyebrow}</span>
      </h1>
      <SaveChip />
      {onBack && (
        <button className="ghost" onClick={onBack} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
      )}
    </header>
  );
}
