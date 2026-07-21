import { Link, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import HistoryPage from "./pages/HistoryPage";
import PreparePage from "./pages/PreparePage";
import ReferencesPage from "./pages/ReferencesPage";
import SignLibraryPage from "./pages/SignLibraryPage";

function NotFoundPage() {
  return (
    <div className="empty-panel not-found">
      <div className="empty-icon" aria-hidden="true">404</div>
      <h1>Page not found</h1>
      <p>The CaptionAid page you requested does not exist.</p>
      <Link className="primary-button" to="/">
        Return to Prepare
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<PreparePage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="signs" element={<SignLibraryPage />} />
        <Route path="references" element={<ReferencesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
