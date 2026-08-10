import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type TableHeadBarProps = {
  title: string;
  search: string;
  onSearch: (value: string) => void;
  // Row count shown beside the title (post-filter).
  count?: number;
  searchPlaceholder?: string;
  className?: string;
  action?: React.ReactNode;
};

// The head bar of a list-view table panel: page title, a row-count chip, and
// the glass search input (T1's input recipe at pill radius — M4). Paired with
// <DataTable /> (which owns the search state and renders this).
export function TableHeadBar({
  title,
  search,
  onSearch,
  count,
  searchPlaceholder = "Search…",
  className,
  action,
}: TableHeadBarProps): React.ReactElement {
  return (
    <div className={cn("head-bar", className)}>
      <h2>{title}</h2>
      {count != null ? <span className="count-chip num">{count}</span> : null}
      {action}
      <div className="search-wrap">
        <Search aria-hidden />
        <input
          type="search"
          className="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={`Search ${title.toLowerCase()}`}
        />
      </div>
    </div>
  );
}
