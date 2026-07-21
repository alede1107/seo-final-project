import { Navigate, Route, Routes } from "react-router-dom";

import Layout from "./components/Layout";
import HistoryPage from "./pages/HistoryPage";
import SignLibraryPage from "./pages/SignLibraryPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HistoryPage />} />
        <Route path="history" element={<Navigate replace to="/" />} />
        <Route path="signs" element={<SignLibraryPage />} />
        <Route path="*" element={<Navigate replace to="/" />} />
      </Route>
    </Routes>
  );
}
