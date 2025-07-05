# 서버 관리 가이드

## 서버 관리 스크립트 사용법

서버 관리를 쉽게 하기 위한 `server-manager.sh` 스크립트를 제공합니다.

### 명령어

```bash
# 서버 상태 확인
./server-manager.sh status

# 서버 시작
./server-manager.sh start

# 서버 중지
./server-manager.sh stop

# 서버 재시작
./server-manager.sh restart
```

### 포트 충돌 해결

포트 4000이 이미 사용 중일 때:

1. **서버 관리 스크립트 사용 (권장)**
   ```bash
   ./server-manager.sh stop
   ./server-manager.sh start
   ```

2. **수동으로 프로세스 종료**
   ```bash
   # 포트 4000을 사용하는 프로세스 확인
   lsof -i :4000
   
   # 프로세스 종료
   kill -SIGTERM <PID>
   
   # 강제 종료 (필요시)
   kill -9 <PID>
   ```

### 로그 확인

```bash
# 실시간 로그 확인
tail -f server.log

# 최근 로그 100줄 확인
tail -n 100 server.log
```

### 일반적인 시작 방법

```bash
# 포그라운드에서 실행 (터미널 창을 차지함)
npm start

# 백그라운드에서 실행 (server-manager.sh 사용 권장)
./server-manager.sh start
```

## 문제 해결

### "Error: listen EADDRINUSE" 오류
- 포트가 이미 사용 중입니다
- 해결: `./server-manager.sh restart` 실행

### 서버가 응답하지 않을 때
1. 서버 상태 확인: `./server-manager.sh status`
2. 로그 확인: `tail -n 50 server.log`
3. 서버 재시작: `./server-manager.sh restart`

### MongoDB 연결 오류
- MongoDB가 실행 중인지 확인
- .env 파일의 MONGODB_URI 설정 확인