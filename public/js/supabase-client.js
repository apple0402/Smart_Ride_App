// ── Supabase 브라우저 클라이언트 초기화 ──────────────────────────────────────
// anon key는 RLS가 보호하는 공개 키입니다. 브라우저 노출 안전.
const SUPABASE_URL      = 'https://jidpwflthppsltdayhoy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_DiyfmExo-3Ycni7PBnNuSQ_zJH6IQRC';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
