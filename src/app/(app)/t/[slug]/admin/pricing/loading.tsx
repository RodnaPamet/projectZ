import { RouteSkeleton } from '@/components/loading/route-skeleton';
import {
  CardListSkeleton,
  CardSkeleton,
  FieldSkeleton,
  PageTitleSkeleton,
} from '@/components/loading/shapes';

/** Pricing: the court picker and its rules, beside the price preview. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <FieldSkeleton />
          <CardListSkeleton rows={3} lines={1} className="gap-2" />
        </div>
        <CardSkeleton lines={4} />
      </div>
    </RouteSkeleton>
  );
}
