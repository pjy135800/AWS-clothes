# GitHub + 무료 서버 배포

GitHub Pages는 정적 파일만 호스팅하므로 `/api/product-lookup` 같은 서버 API를 실행할 수 없습니다. 이 프로토타입은 GitHub에 코드를 올리고, Render/Railway 같은 무료 서버가 그 저장소를 실행하는 구조가 맞습니다.

## Render 무료 배포 흐름

1. 이 폴더 내용을 GitHub 저장소에 올립니다.
2. Render에서 `New Web Service`를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. 설정은 아래처럼 둡니다.

```text
Runtime: Node
Build Command: 비워둠
Start Command: node server.js
Plan: Free
```

5. 배포가 끝난 뒤 Render URL로 접속합니다.

## 왜 이 방식인가

- 프론트 화면과 `/api/product-lookup` 서버가 같은 도메인에서 실행됩니다.
- 브라우저 CORS 문제를 피할 수 있습니다.
- API 키 없이도 무료 실험용 검색/상품 메타데이터 수집을 테스트할 수 있습니다.

## 주의

- 현재 상품 조회 방식은 무료 실험용 검색 수집입니다.
- DuckDuckGo 검색 결과나 무신사 상품 페이지 구조가 바뀌면 실패할 수 있습니다.
- 상업 서비스로 확장하려면 정식 검색 API, 제휴 API, 또는 쇼핑몰별 허용 정책 확인이 필요합니다.
