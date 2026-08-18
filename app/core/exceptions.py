class NotFoundException(Exception):
    def __init__(self, detail: str = "Resource not found"):
        self.detail = detail
