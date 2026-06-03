"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useUserStore } from "@/stores/user-store";
import { createBrowserClient } from "@/lib/supabase/client";

type FormValues = {
  display_name: string;
  bio: string;
  country_code: string;
};

export default function EditProfilePage() {
  const router = useRouter();
  const { toast } = useToast();
  const { profile, setProfile } = useUserStore();

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting, isDirty },
  } = useForm<FormValues>({
    defaultValues: {
      display_name: "",
      bio: "",
      country_code: "",
    },
  });

  useEffect(() => {
    if (profile) {
      reset({
        display_name: profile.display_name ?? "",
        bio: profile.bio ?? "",
        country_code: profile.country_code ?? "",
      });
    }
  }, [profile, reset]);

  async function onSubmit(values: FormValues) {
    const userId = profile?.id;
    if (!userId) {
      toast({ title: "Not authenticated", variant: "destructive" });
      return;
    }

    const supabase = createBrowserClient();
    const { error } = await supabase
      .from("profiles")
      .update({
        display_name: values.display_name,
        bio: values.bio || null,
        country_code: values.country_code || null,
      })
      .eq("id", userId);

    if (error) {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
      return;
    }

    if (profile) {
      setProfile({
        ...profile,
        display_name: values.display_name,
        bio: values.bio || null,
        country_code: values.country_code || null,
      });
    }

    toast({ title: "Profile updated", variant: "success" });
    router.back();
  }

  return (
    <AppShell>
      <div className="flex h-full flex-col overflow-y-auto no-scrollbar">
        <div className="p-4">
          <Button
            variant="ghost"
            size="sm"
            className="mb-4 gap-1.5 text-muted-foreground"
            onClick={() => router.back()}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>

          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Crosstown character</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Build or refresh the same structured character data we use for Viktor, Darius, and the rest —
                photos, quick choices, questionnaire, optional intro video.
              </p>
              <Button asChild variant="outline" className="w-full justify-start gap-2">
                <Link href="/onboarding/character?update=1">
                  <Sparkles className="h-4 w-4" />
                  Open character builder
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Edit Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="display_name">
                    Display Name
                  </label>
                  <Input
                    id="display_name"
                    placeholder="Your display name"
                    {...register("display_name", { required: true, minLength: 1, maxLength: 60 })}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="bio">
                    Bio
                  </label>
                  <Input
                    id="bio"
                    placeholder="Tell us about yourself"
                    {...register("bio", { maxLength: 300 })}
                  />
                  <p className="text-xs text-muted-foreground">Max 300 characters</p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="country_code">
                    Country Code
                  </label>
                  <Input
                    id="country_code"
                    placeholder="US"
                    maxLength={2}
                    className="w-24 uppercase"
                    {...register("country_code", { maxLength: 2 })}
                  />
                  <p className="text-xs text-muted-foreground">Two-letter code (e.g. US, GB)</p>
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={isSubmitting || !isDirty}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save Changes"
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
