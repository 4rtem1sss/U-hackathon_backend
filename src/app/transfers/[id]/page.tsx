import { TrackView } from "@/components/track/TrackView";

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TrackView id={id} />;
}
