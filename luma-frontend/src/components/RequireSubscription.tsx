import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import LockedFeature from "./LockedFeature";
import { useAuth } from "../context/AuthContext";

export default function RequireSubscription({
  children,
  featureName = "this premium feature",
  title,
  description,
}: {
  children: ReactNode;
  featureName?: string;
  title?: string;
  description?: string;
}) {
  const { loading, user } = useAuth();

  if (loading) {
    return null;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.subscription_status !== "premium") {
    return (
      <LockedFeature
        featureName={featureName}
        title={title}
        description={description}
        autoOpen
      />
    );
  }

  return <>{children}</>;
}
