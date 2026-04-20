import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getCharacterBySlug } from "@/actions/characters";

export const dynamic = "force-dynamic";

export default async function CharacterProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { character } = await getCharacterBySlug(slug);
  if (!character) notFound();

  return (
    <AppShell>
      <div className="h-full overflow-y-auto p-4">
        <Card>
          <CardHeader>
            <CardTitle>{character.name}</CardTitle>
            <p className="text-xs text-muted-foreground">{character.tagline ?? "Camtok live character"}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {character.camtok_entity_type ?? "pedestrian"}
              </Badge>
              <Badge variant={character.camtok_active === false ? "destructive" : "success"}>
                {character.camtok_active === false ? "inactive" : "active"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              This profile now uses Camtok live model. Legacy clip/story stats were archived.
            </p>
            <div className="flex gap-2">
              <Button asChild>
                <Link href={`/live/go/${character.id}`}>Go live</Link>
              </Button>
              <Button asChild variant="secondary">
                <Link href="/characters">Back to characters</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
