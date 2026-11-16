import { settingsSectionId } from "@/lib/settings-sections";

// One settings section — heading, dim description, and the control block
// (the T7 section grammar; hairline dividers come from `.s-section`). Its id,
// from its title, is the anchor the ⌘K finder opens (#640). `badge` sits in
// the heading after the title, as Unattributed usage's count pill does (#639).
// `action` sits at the heading's far end, as the Claude section's "+ Add
// account" does (#621); without one the heading is the bare h2.
export function Section({
  title,
  description,
  badge,
  action,
  children,
}: {
  title: string;
  description: React.ReactNode;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const heading = (
    <h2>
      {title}
      {badge}
    </h2>
  );
  return (
    <section className="s-section" id={settingsSectionId(title)} aria-label={title}>
      {action === undefined ? (
        heading
      ) : (
        <div className="s-head">
          {heading}
          {action}
        </div>
      )}
      <p className="desc">{description}</p>
      <div className="control">{children}</div>
    </section>
  );
}
