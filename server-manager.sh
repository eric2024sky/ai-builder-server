#!/bin/bash

# 서버 관리 스크립트
# 사용법: ./server-manager.sh [start|stop|restart|status]

SERVER_DIR="/Users/kjh/Desktop/aa/dd/ai-builder-server"
PORT=4000
PID_FILE="$SERVER_DIR/server.pid"

# 서버 상태 확인
check_status() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p $PID > /dev/null 2>&1; then
            echo "✅ 서버가 실행 중입니다 (PID: $PID)"
            return 0
        else
            echo "⚠️  PID 파일은 있지만 프로세스가 없습니다"
            rm -f "$PID_FILE"
        fi
    fi
    
    # 포트 기반 확인
    PORT_PID=$(lsof -ti :$PORT 2>/dev/null)
    if [ ! -z "$PORT_PID" ]; then
        echo "⚠️  포트 $PORT가 다른 프로세스에서 사용 중입니다 (PID: $PORT_PID)"
        return 1
    fi
    
    echo "❌ 서버가 실행되고 있지 않습니다"
    return 1
}

# 서버 시작
start_server() {
    if check_status > /dev/null; then
        echo "서버가 이미 실행 중입니다"
        return 1
    fi
    
    echo "🚀 서버를 시작합니다..."
    cd "$SERVER_DIR"
    nohup npm start > server.log 2>&1 &
    SERVER_PID=$!
    echo $SERVER_PID > "$PID_FILE"
    
    sleep 3
    if ps -p $SERVER_PID > /dev/null; then
        echo "✅ 서버가 성공적으로 시작되었습니다 (PID: $SERVER_PID)"
        echo "📝 로그 확인: tail -f $SERVER_DIR/server.log"
    else
        echo "❌ 서버 시작에 실패했습니다"
        rm -f "$PID_FILE"
        return 1
    fi
}

# 서버 중지
stop_server() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p $PID > /dev/null 2>&1; then
            echo "🛑 서버를 중지합니다 (PID: $PID)..."
            kill -SIGTERM $PID
            sleep 2
            
            if ps -p $PID > /dev/null 2>&1; then
                echo "⚠️  강제 종료합니다..."
                kill -SIGKILL $PID
            fi
            
            rm -f "$PID_FILE"
            echo "✅ 서버가 중지되었습니다"
            return 0
        fi
    fi
    
    # PID 파일이 없거나 프로세스가 없는 경우, 포트 기반으로 확인
    PORT_PID=$(lsof -ti :$PORT 2>/dev/null)
    if [ ! -z "$PORT_PID" ]; then
        echo "⚠️  포트 $PORT를 사용하는 프로세스를 종료합니다 (PID: $PORT_PID)..."
        kill -SIGTERM $PORT_PID
        sleep 2
        
        if lsof -ti :$PORT > /dev/null 2>&1; then
            kill -SIGKILL $PORT_PID
        fi
        
        echo "✅ 프로세스가 종료되었습니다"
    else
        echo "❌ 실행 중인 서버가 없습니다"
    fi
}

# 서버 재시작
restart_server() {
    echo "🔄 서버를 재시작합니다..."
    stop_server
    sleep 2
    start_server
}

# 메인 명령 처리
case "$1" in
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    restart)
        restart_server
        ;;
    status)
        check_status
        ;;
    *)
        echo "사용법: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac