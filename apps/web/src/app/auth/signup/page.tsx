"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingConfirmationEmail, setPendingConfirmationEmail] = useState<string | null>(null);
  const router = useRouter();
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const supabase = createBrowserClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/feed`,
        data: {
          username,
          display_name: username,
        },
      },
    });

    if (error) {
      toast({
        title: "Signup failed",
        description: error.message,
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    if (!data.session) {
      setPendingConfirmationEmail(email);
      toast({
        title: "Check your email",
        description: "We sent a confirmation link. Open it to activate your account.",
        variant: "success",
      });
      setLoading(false);
      return;
    }

    toast({
      title: "Welcome to BetTok!",
      description: "Your account has been created with $1,000 demo balance.",
      variant: "success",
    });

    router.push("/feed");
    router.refresh();
  }

  async function resendConfirmationEmail() {
    const resendEmail = pendingConfirmationEmail ?? email;
    if (!resendEmail) return;

    setLoading(true);
    const supabase = createBrowserClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: resendEmail,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/feed`,
      },
    });

    if (error) {
      toast({
        title: "Could not resend confirmation",
        description: error.message,
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    toast({
      title: "Confirmation sent",
      description: `We sent another confirmation email to ${resendEmail}.`,
      variant: "success",
    });
    setLoading(false);
  }

  async function signUpWithGoogle() {
    setLoading(true);
    const supabase = createBrowserClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=/feed`,
      },
    });
    if (error) {
      toast({ title: "Google sign-up failed", description: error.message, variant: "destructive" });
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-4">
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          <span className="text-primary">Bet</span>Tok
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Join the prediction game
        </p>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create account</CardTitle>
          <CardDescription>
            Start with $1,000 demo balance
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="username">
                Username
              </label>
              <Input
                id="username"
                type="text"
                placeholder="coolpredictor"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                minLength={3}
                maxLength={30}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="email">
                Email
              </label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="password">
                Password
              </label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating account..." : "Create account"}
            </Button>
            <div className="relative py-2">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card text-muted-foreground px-2">Or</span>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={() => void signUpWithGoogle()}
            >
              Continue with Google
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/auth/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </p>
          {pendingConfirmationEmail ? (
            <div className="mt-3 text-center text-sm text-muted-foreground">
              Not seeing the email?{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => void resendConfirmationEmail()}
                disabled={loading}
              >
                Resend confirmation
              </button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
