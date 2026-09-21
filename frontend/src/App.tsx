/**
 * AquaShield 3D — App Root
 * Public: landing, login, register. Operations shell: modules + assistant + admin.
 */

import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import Landing from './auth/Landing';
import Login from './auth/Login';
import Register from './auth/Register';
import Dashboard from './modules/incident-console/Dashboard';
import ImpactIntelligence from './modules/impact/ImpactIntelligence';
import IncidentConsole from './modules/incident-console/IncidentConsole';
import EapDashboard from './modules/eap-dashboard/EapDashboard';
import AlertConsole from './modules/alert-console/AlertConsole';
import EvacuationPlanner from './modules/evacuation-planner/EvacuationPlanner';
import ReportGenerator from './modules/report-generator/ReportGenerator';
import Assistant from './modules/assistant/Assistant';
import Admin from './modules/admin/Admin';
import { storedToken } from './api/client';

/** Public portal home; signed-in officials land straight on the dashboard. */
function RootGate() {
  return storedToken() ? <Navigate to="/dashboard" replace /> : <Landing />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootGate />} />
      <Route path="login" element={<Login />} />
      <Route path="register" element={<Register />} />
      <Route element={<Layout />}>
        <Route path="dashboard" element={<ErrorBoundary fallbackLabel="Dashboard Error"><Dashboard /></ErrorBoundary>} />
        <Route path="impact" element={<ErrorBoundary fallbackLabel="Impact Assessment Error"><ImpactIntelligence /></ErrorBoundary>} />
        <Route path="incident" element={<ErrorBoundary fallbackLabel="Incident Console Error"><IncidentConsole /></ErrorBoundary>} />
        <Route path="eap" element={<ErrorBoundary fallbackLabel="EAP Dashboard Error"><EapDashboard /></ErrorBoundary>} />
        <Route path="alerts" element={<ErrorBoundary fallbackLabel="Alert Console Error"><AlertConsole /></ErrorBoundary>} />
        <Route path="evacuation" element={<ErrorBoundary fallbackLabel="Evacuation Planner Error"><EvacuationPlanner /></ErrorBoundary>} />
        <Route path="reports" element={<ErrorBoundary fallbackLabel="Report Generator Error"><ReportGenerator /></ErrorBoundary>} />
        <Route path="assistant" element={<ErrorBoundary fallbackLabel="Assistant Error"><Assistant /></ErrorBoundary>} />
        <Route path="admin" element={<ErrorBoundary fallbackLabel="Admin Error"><Admin /></ErrorBoundary>} />
      </Route>
    </Routes>
  );
}

