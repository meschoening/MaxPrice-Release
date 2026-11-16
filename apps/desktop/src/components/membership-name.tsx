import { membershipNameText, organizationLabelParts, type MembershipName } from "@maxprice/shared";
import { cn } from "@/lib/utils";

// A Membership's name in its two parts (`scopeMembershipName`): the
// Organization's label, then ` · Account` when the set spans Accounts. Two
// Memberships of one Organization differ only in the Account half (#619:
// "Northwind · Work" and "Northwind · Consulting"), so `.mname` ellipsizes the
// Organization part first and keeps the Account half whole, ellipsizing it too
// only when it alone outgrows the room. Two Organizations on one plan word
// differ only in their labels' collision suffix ("Max plan · 1a2b3c4d" and
// "Max plan · 5e6f7a8b", `organizationLabelParts`), so the suffix stays whole
// while the label ellipsizes, yielding only beside an Account half (#647).
// The title carries the full name (`title`, where the surface names it more
// fully than `name`).
export function MembershipNameView({
  name,
  className,
  title,
}: {
  name: MembershipName;
  className?: string;
  title?: string;
}): React.ReactElement {
  return (
    <span className={cn("mname", className)} title={title ?? membershipNameText(name)}>
      <OrganizationLabelParts label={name.organization} yields={name.account !== null} />
      {name.account !== null ? (
        <>
          <span className="mname-sep"> · </span>
          <span className="mname-acct">
            <bdi>{name.account}</bdi>
          </span>
        </>
      ) : null}
    </span>
  );
}

// A rendered Organization label as `.mname` children: the label, which
// ellipsizes first, then its collision suffix, if any (#647), which `yields`
// once the label is gone when an Account half follows it. For a surface that
// draws an Organization's label in its own element too, as Live's limit cards
// and board do.
export function OrganizationLabelParts({
  label,
  yields = false,
}: {
  label: string;
  yields?: boolean;
}): React.ReactElement {
  const parts = organizationLabelParts(label);
  return (
    <>
      <span className="mname-org">{parts.label}</span>
      {parts.suffix !== null ? (
        <span className={cn("mname-suffix", yields && "mname-suffix-yields")}>
          {` · ${parts.suffix}`}
        </span>
      ) : null}
    </>
  );
}
