import { Link } from "react-router-dom";
import { SETTINGS_SECTIONS, settingsSectionId } from "@/lib/settings-sections";

// The note over a session whose every event reads $0.00: it has no stored
// cost, and the cost mode, which only Settings › Cost mode sets, prices its
// tokens.
export function ZeroCostNote(): React.ReactElement {
  return (
    <div className="inset">
      <p>
        All events read <b>$0.00</b> — this session has no stored cost. Set{" "}
        <Link to={`/settings#${settingsSectionId(SETTINGS_SECTIONS.costMode)}`}>
          Settings › {SETTINGS_SECTIONS.costMode}
        </Link>{" "}
        to <b style={{ color: "var(--accent)" }}>calculate</b> to price its tokens.
      </p>
    </div>
  );
}
