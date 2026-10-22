import { Navigate, useParams } from 'react-router-dom';

// The check table lived here: every receipt of a case as a row of small
// boxes, the picture opening beside whichever row was picked. The review page
// (CaseReview.jsx) does that job one receipt at a time with the picture always
// beside it, so this address only sends old links and bookmarks there.
export default function CaseCheck() {
  const { id } = useParams();
  return <Navigate to={`/reports/${encodeURIComponent(id)}/review`} replace />;
}
