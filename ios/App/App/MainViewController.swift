// 앱 전용 로컬 플러그인(BackgroundSafety)을 브릿지에 수동 등록하는 커스텀 브릿지 뷰컨트롤러
// — npm 패키지가 아니라 capacitor.config.json의 packageClassList(cap sync 시 자동 생성/덮어쓰기)에는 포함되지 않으므로 여기서 직접 등록
import Capacitor

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundSafetyPlugin())
    }
}
