import React from "react";
import AdminOverview from "./AdminOverview";
import AdminUsers from "./AdminUsers";
import AdminTimetables from "./AdminTimetables";
import AdminLiveClasses from "./AdminLiveClasses";
import AdminVideos from "./AdminVideos";
import AdminAssignments from "./AdminAssignments";
import AdminMessages from "./AdminMessages";
import AdminAnalytics from "./AdminAnalytics";
import AIChatAssistant from "../AIChatAssistant";

export default function AdminDashboard({ view, user }) {
  if (view === "admin-users") return <AdminUsers />;
  if (view === "admin-teachers") return <AdminUsers roleFilter="teacher" />;
  if (view === "admin-students") return <AdminUsers roleFilter="student" />;
  if (view === "admin-timetables") return <AdminTimetables />;
  if (view === "admin-live-classes") return <AdminLiveClasses />;
  if (view === "admin-videos") return <AdminVideos />;
  if (view === "admin-assignments") return <AdminAssignments />;
  if (view === "admin-messages") return <AdminMessages />;
  if (view === "admin-analytics") return <AdminAnalytics />;
  if (view === "admin-ai-assistant") return <AIChatAssistant user={user} />;
  return <AdminOverview />;
}
