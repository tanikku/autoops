-- CreateTable
CREATE TABLE "DomainThrottle" (
    "host" TEXT NOT NULL,
    "nextAllowedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainThrottle_pkey" PRIMARY KEY ("host")
);
